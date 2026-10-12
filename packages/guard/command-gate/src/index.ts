/**
 * Command gate: classify a shell command on `tools/pre-execute` and stop the
 * destructive ones before the executor sees them.
 *
 * Hydra runs unattended for days, and only a commit can restore what a
 * command destroys. A command that discards uncommitted work, rewrites history,
 * writes outside the workspace, or reprograms the machine leaves nothing to
 * restore, so it is refused here rather than repaired afterwards.
 * The decision is made in the operation that dispatches the call, so a caller
 * that bypasses the model still meets it. A call that names no agent, or whose
 * session records no working directory, has no workspace to judge paths
 * against and is not classified.
 * @module @deepseek-ai/dsh-command-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: resolves the optional `ctx.approval` service declaration.
import type {} from '@deepseek-ai/dsh-user-approval'
import { classifyCommandLine } from './classify.ts'
import type { BlockedAttempt, Classification, CommandContext } from './types.ts'

export type * from './types.ts'
export { classifyCommand, classifyCommandLine, resolvePath, within } from './classify.ts'
export { basename, parseCommandLine } from './parse.ts'

export const name = 'command-gate'
export const inject = ['tools', 'commands']

/** How many blocked attempts one session keeps for `/commands-gate`. */
const HISTORY = 20

/** Command-gate configuration. */
export interface Config {
  /**
   * `off` disables the gate; `confirm` asks a human before a command that
   * destroys uncommitted work and denies the rest; `deny` refuses both without
   * asking.
   */
  mode: 'off' | 'confirm' | 'deny'
  /**
   * What a `confirm` verdict becomes when no human can answer. `deny` refuses
   * with the gate's own explanation; `confirm` still raises the approval, which
   * a machine answerer may grant and an absent channel turns into a denial.
   */
  unattendedMode: 'confirm' | 'deny'
  /** Rule ids downgraded to `allow`, for a deployment that accepts one risk. */
  allow: string[]
  /** Extra command prefixes to deny, each written as it would be typed. */
  denyExtra: string[]
  /** Absolute paths where destroying files is expected, such as a scratch root. */
  temporaryRoots: string[]
}

/** Runtime configuration schema for the command gate. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'confirm', 'deny'] as const).default('confirm'),
  unattendedMode: z.union(['confirm', 'deny'] as const).default('deny'),
  allow: z.array(z.string()).default([]),
  denyExtra: z.array(z.string()).default([]),
  temporaryRoots: z.array(z.string()).default([]),
})

/** The arguments of a shell tool call that the gate reads. */
interface ShellCall {
  /** The command line as the model wrote it. */
  readonly command: string
  /** The call's `workdir` argument, not yet validated. */
  readonly workdir: unknown
}

/**
 * The command line and `workdir` a shell tool call carries, when this call is one.
 * @param exec - the pending tool execution.
 * @returns the call's arguments, or `undefined` for a tool the gate does not read.
 */
function shellCallOf(exec: ToolExecution): ShellCall | undefined {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const { command, workdir } = args as { command?: unknown; workdir?: unknown }
  return typeof command === 'string' && command.trim().length > 0 ? { command, workdir } : undefined
}

/**
 * The directory a shell call would run in: its own `workdir` when it names
 * one, else the session workspace.
 * @param workdir - the call's `workdir` argument.
 * @param workspace - the session's workspace root.
 * @returns the absolute working directory.
 */
function workingDirectory(workdir: unknown, workspace: string): string {
  if (typeof workdir !== 'string' || workdir.length === 0) return workspace
  return workdir.startsWith('/') ? workdir : `${workspace}/${workdir}`
}

/**
 * Whether a human can answer an approval for this call right now. An absent
 * approval service and a session whose policy already rejects every ask both
 * mean nobody will.
 * @param ctx - the plugin context holding the optional approval service.
 * @param agent - the calling agent.
 * @returns true when no human decision is reachable.
 */
function unattended(ctx: Context, agent: Agent): boolean {
  const approval = ctx.get('approval')
  if (approval === undefined) return true
  return approval.overrideOf(agent.session) === 'never'
}

/**
 * Register the gate, its command, and the per-session block history.
 * @param ctx - registrant context carrying the tool and command registries.
 * @param config - the deployment's command policy.
 */
export function apply(ctx: Context, config: Config): void {
  const history = new Map<SessionId, BlockedAttempt[]>()
  const denyExtra = config.denyExtra
    .map(pattern => pattern.trim().split(/\s+/).filter(word => word.length > 0))
    .filter(words => words.length > 0)

  /** Record one refusal in memory and in the calling session's log. */
  function record(agent: Agent, attempt: BlockedAttempt): void {
    const kept = history.get(agent.id) ?? []
    kept.push(attempt)
    if (kept.length > HISTORY) kept.splice(0, kept.length - HISTORY)
    history.set(agent.id, kept)
    // Audit only: nothing reads it back, so a reader that does not know the
    // type may skip it rather than refuse the whole log.
    agent.session.append('command-gate/blocked', attempt, { ignorable: true })
  }

  ctx.on('agent/disposed', ({ agent }) => { history.delete(agent.id) })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (config.mode === 'off') return next()
    const call = shellCallOf(exec)
    if (call === undefined) return next()
    // Without an agent whose session names a workspace there is nothing to
    // judge paths against, so the call is left to the tool.
    const agent = exec.agent
    const workspace = agent?.session.header.cwd
    if (agent === undefined || workspace === undefined) return next()
    const context: CommandContext = {
      cwd: workingDirectory(call.workdir, workspace),
      workspace,
      temporaryRoots: config.temporaryRoots,
      allow: config.allow,
      denyExtra,
    }
    const found: Classification = classifyCommandLine(call.command, context)
    if (found.verdict === 'allow') return next()

    const deniedOutright = found.verdict === 'deny'
    const degraded = !deniedOutright
      && (config.mode === 'deny' || (config.unattendedMode === 'deny' && unattended(ctx, agent)))
    if (deniedOutright || degraded) {
      record(agent, {
        tool: exec.name,
        command: call.command,
        rule: found.rule,
        verdict: deniedOutright ? 'deny' : 'confirm',
        reason: found.reason,
      })
      return { kind: 'deny', reason: found.reason }
    }
    // A human may still want this one: the approval stack owns the answer and
    // writes its own asked/decided audit pair.
    return { kind: 'ask', reason: found.reason }
  })

  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-gate'),
    name: 'commands-gate',
    description: 'Show the command gate policy and what it recently blocked',
    handler: (invocation): CommandResult => {
      const blocked = history.get(invocation.agent.id) ?? []
      const lines = [
        `Command gate: ${config.mode}${config.mode === 'off' ? '' : ` (unattended: ${config.unattendedMode})`}`,
      ]
      if (config.allow.length > 0) lines.push(`Allowed rules: ${config.allow.join(', ')}`)
      if (config.temporaryRoots.length > 0) lines.push(`Temporary roots: ${config.temporaryRoots.join(', ')}`)
      lines.push('', blocked.length === 0 ? 'Nothing blocked in this session.' : `Blocked ${String(blocked.length)}:`)
      for (const attempt of blocked) {
        lines.push(`  [${attempt.rule}] ${attempt.command}`)
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}
