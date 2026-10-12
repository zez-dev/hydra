/**
 * Environment self-check for Hydra. `/doctor` prints a table of `ok`, `warn`,
 * and `fail` rows with a one-line fix each; the read-only `doctor` tool of
 * the `./tools` entry returns the same report as JSON. Checks cover the
 * Harness home, the workspace, sandboxing, the native addon, git, mounted
 * Hydra plugins, tool calling compat rows, credentials, and an optional live
 * model probe. The only mutation is `--fix`, which creates the two `.dsh/`
 * workspace folders. Named exports preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-doctor
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import {
  checkGit, checkHome, checkNativeAddon, checkSandbox, checkVersion, checkWorkspace, classifyProbeError, errorMessage, firstLine,
  renderReport, summarize, WORKSPACE_FOLDERS,
} from './checks.ts'
import { nodeEnvironment } from './host.ts'
import type {
  DoctorEnvironment, DoctorOptions, DoctorReport, DoctorRoute, DoctorRow, DoctorService,
} from './types.ts'

export type * from './types.ts'
export {
  checkGit, checkHome, checkNativeAddon, checkSandbox, checkVersion, checkWorkspace, classifyProbeError, FIXES, HYDRA_VERSION, renderReport,
  summarize, WORKSPACE_FOLDERS,
} from './checks.ts'

export const name = 'doctor'
export const inject = ['commands', 'llm']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Environment self-check; provided by `dsh-doctor`. */
    doctor: DoctorService
  }
}

/** Doctor configuration. */
export interface Config {
  /** Deadline of one live probe request in milliseconds. */
  probeTimeoutMs: number
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  probeTimeoutMs: z.natural().min(1000).default(20_000),
})

/** Hydra services whose presence the plugins section reports; each maps to a `dsh-base` row. */
const HYDRA_SERVICES = [
  'memory', 'learning', 'research', 'notify', 'spendGuard', 'cronSessions', 'digest',
  'goals', 'commands', 'tools', 'llm',
] as const

/**
 * Report name of each cordis `FiberState`. The const enum has no runtime
 * object across packages, so the keys mirror its vendored numeric values.
 */
const FIBER_STATE_NAMES: Record<FiberState, string> = {
  [0 as FiberState.PENDING]: 'pending',
  [1 as FiberState.LOADING]: 'loading',
  [2 as FiberState.ACTIVE]: 'active',
  [3 as FiberState.FAILED]: 'failed',
  [4 as FiberState.DISPOSED]: 'disposed',
  [5 as FiberState.UNLOADING]: 'unloading',
}

/** Structural seams read only when mounted. */
interface LoaderEntrySeam {
  /** The Loader assigns every row an `id`, generated when cordis.yml names none. */
  options: { id: string; name: string; config?: unknown; disabled?: unknown }
  fiber?: { state: FiberState; inject: Record<string, unknown>; ctx: { get(name: string): unknown } } | null
}
interface LoaderSeam {
  entries(): Iterable<LoaderEntrySeam>
}
interface CredentialsSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
}
interface SettingsSeam {
  get(ns: string): unknown
}
interface DefaultModelSeam {
  currentSelection(): { provider: string; model: string } | undefined
}
interface ProfileSeam {
  name: string
}

/**
 * Parse `/doctor` arguments.
 * @param rawInput - text after the command name.
 * @returns probe, fix, and an optional `provider/model` route.
 */
export function parseDoctorInput(rawInput: string): { probe: boolean; fix: boolean; route?: DoctorRoute } {
  const words = rawInput.trim().split(/\s+/).filter(word => word !== '')
  let probe = false
  let fix = false
  let route: DoctorRoute | undefined
  for (const word of words) {
    if (word === '--probe') probe = true
    else if (word === '--fix') fix = true
    else if (word.includes('/')) {
      const slash = word.indexOf('/')
      route = { provider: word.slice(0, slash), model: word.slice(slash + 1) }
      probe = true
    }
  }
  return { probe, fix, ...route === undefined ? {} : { route } }
}

/** The skill-lock service, read structurally so doctor works without that package. */
interface SkillLockSeam {
  status(cwd: string, signal?: AbortSignal): Promise<readonly { readonly state: string; readonly name: string }[]>
}

/**
 * Install `ctx.doctor` and `/doctor`.
 * @param ctx - plugin context carrying `commands` and `llm`; `loader`,
 *   `credentials`, `settings`, `agentDefaultModel`, `profileContext`, and the Hydra services are read when mounted.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Read per run, so an environment set on `ctx.doctor.internals` after activation applies.
  const environment = (): DoctorEnvironment => service.internals.environment ?? nodeEnvironment()

  function loaderEntries(): LoaderEntrySeam[] {
    const loader = ctx.get('loader') as LoaderSeam | undefined
    if (loader === undefined || typeof loader.entries !== 'function') return []
    return [...loader.entries()]
  }

  function rowConfig(packageName: string): Record<string, unknown> | undefined {
    const entry = loaderEntries().find(candidate => candidate.options.name === packageName)
    const value = entry?.options.config
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
  }

  async function checkSkillLock(cwd: string): Promise<DoctorRow[]> {
    const lock = ctx.get('skillLock') as SkillLockSeam | undefined
    if (lock === undefined) return []
    let entries: readonly { readonly state: string; readonly name: string }[]
    try {
      entries = await lock.status(cwd)
    } catch (error) {
      return [{
        section: 'skills', check: 'skill lockfile', status: 'warn',
        detail: errorMessage(error),
        fix: 'fix or delete the lockfile, then run /skills-lock lock',
      }]
    }
    const counts = new Map<string, number>()
    for (const entry of entries) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1)
    const drifted = counts.get('drifted') ?? 0
    const fresh = counts.get('new') ?? 0
    const locked = counts.get('locked') ?? 0
    const detail = `${String(locked)} locked, ${String(drifted)} drifted, ${String(fresh)} new`
    return [drifted === 0 && fresh === 0
      ? { section: 'skills', check: 'skill lockfile', status: 'ok', detail }
      : {
        section: 'skills', check: 'skill lockfile', status: 'warn', detail,
        fix: 'review the changes, then run /skills-lock lock to record them as trusted',
      }]
  }

  function checkTools(): DoctorRow[] {
    const tools = rowConfig('@deepseek-ai/dsh-tools')
    const source = tools === undefined ? 'no Loader row found; reads the mounted `tools` row config' : undefined
    const rows: DoctorRow[] = []
    const coercion = tools?.['argumentCoercion']
    rows.push(coercion === 'lenient'
      ? { section: 'tools', check: 'argument coercion', status: 'ok', detail: 'lenient' }
      : { section: 'tools', check: 'argument coercion', status: 'warn', detail: source ?? `${typeof coercion === 'string' ? coercion : 'none'}; GLM/Qwen send numbers as strings`, fix: 'set argumentCoercion: lenient on the tools row (dsh-base ships it on)' })
    const nullable = tools?.['nullableParameters']
    rows.push(nullable === 'flat'
      ? { section: 'tools', check: 'nullable parameters', status: 'ok', detail: 'flat' }
      : { section: 'tools', check: 'nullable parameters', status: 'warn', detail: source ?? `${typeof nullable === 'string' ? nullable : 'oneOf'}; weak parsers mishandle oneOf`, fix: 'set nullableParameters: flat on the tools row (dsh-base ships it on)' })
    for (const pkg of ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-pwsh']) {
      const entry = loaderEntries().find(candidate => candidate.options.name === pkg)
      // The Loader mounts no fiber for a disabled row, whether `disabled` is `true` or an expression.
      if (entry?.fiber === undefined || entry.fiber === null) continue
      const required = (entry.options.config as Record<string, unknown> | undefined)?.['requireDescription']
      const short = pkg.replace('@deepseek-ai/dsh-', '')
      rows.push(required === false
        ? { section: 'tools', check: `${short} description`, status: 'ok', detail: 'optional' }
        : { section: 'tools', check: `${short} description`, status: 'warn', detail: 'required; models that omit it fail every shell call', fix: `set requireDescription: false on the ${short} row and in the agent presets` })
    }
    return rows
  }

  function checkPlugins(): DoctorRow[] {
    const rows: DoctorRow[] = []
    const entries = loaderEntries()
    for (const entry of entries) {
      const fiber = entry.fiber
      if (fiber === undefined || fiber === null || entry.options.disabled === true) continue
      const state = FIBER_STATE_NAMES[fiber.state]
      if (state === 'active') continue
      const missing = state === 'pending' ? Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined) : []
      rows.push({
        section: 'plugins',
        check: entry.options.id,
        status: state === 'failed' ? 'fail' : 'warn',
        detail: state === 'pending' ? `pending (waiting for ${missing.join(', ') || 'a service'})` : `fiber state ${state}`,
        fix: state === 'failed' ? 'read the startup log under $DSH_HOME/logs for the activation error' : 'mount the missing service or disable the row',
      })
    }
    for (const key of HYDRA_SERVICES) {
      const present = ctx.get(key) !== undefined
      rows.push(present
        ? { section: 'plugins', check: key, status: 'ok', detail: 'mounted' }
        : { section: 'plugins', check: key, status: 'warn', detail: 'not mounted', fix: `enable the ${key} row in the profile patch (dsh-base ships it)` })
    }
    return rows
  }

  async function checkCredentials(): Promise<DoctorRow[]> {
    const rows: DoctorRow[] = []
    const credentials = ctx.get('credentials') as CredentialsSeam | undefined
    const settings = ctx.get('settings') as SettingsSeam | undefined
    const refs = new Map<string, string>()
    refs.set('deepseek-official', 'DEEPSEEK_API_KEY')
    const piAi = settings === undefined ? undefined : settings.get('llm-pi-ai') as { providers?: Record<string, { apiKeyEnv?: string } | undefined> } | undefined
    for (const [provider, profile] of Object.entries(piAi?.providers ?? {})) {
      if (typeof profile?.apiKeyEnv === 'string') refs.set(provider, profile.apiKeyEnv)
    }
    for (const [provider, ref] of refs) {
      let resolved = false
      if (credentials !== undefined) {
        try {
          resolved = ((await credentials.resolve(ref))?.value ?? '').length > 0
        } catch {
          // A broken credential store reads as unresolved.
          resolved = false
        }
      } else {
        resolved = (environment().env[ref] ?? '').length > 0
      }
      rows.push(resolved
        ? { section: 'credentials', check: provider, status: 'ok', detail: `${ref} resolves` }
        : { section: 'credentials', check: provider, status: 'warn', detail: `${ref} is not set`, fix: `put ${ref}=... in $DSH_HOME/.env or save the key on the Models page` })
    }
    return rows
  }

  async function probeRoute(route: DoctorRoute, agent: Agent | undefined): Promise<DoctorRow> {
    const check = `probe ${route.provider}/${route.model}`
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error(`probe timed out after ${String(config.probeTimeoutMs)} ms`)) }, config.probeTimeoutMs)
    const started = Date.now()
    try {
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with the single word pong.' }], source: { kind: 'user' } })],
        maxTokens: 8,
        purpose: 'doctor-probe',
        signal: controller.signal,
        ...agent === undefined ? {} : { sessionId: agent.session.id },
      })
      // Adapter failures arrive as a terminal finish chunk, not a throw.
      let terminal: FinishReason | undefined
      for await (const chunk of stream) {
        if (chunk.type === 'finish') terminal = chunk.reason
      }
      if (terminal !== undefined && (terminal.kind === 'error' || terminal.kind === 'aborted')) {
        throw Object.assign(new Error(terminal.failure.message), { code: terminal.failure.code })
      }
      return { section: 'credentials', check, status: 'ok', detail: `${String(Date.now() - started)} ms` }
    } catch (error) {
      const kind = classifyProbeError(error)
      const fixes: Record<typeof kind, string> = {
        auth: 'the key is rejected: save a valid key on the Models page or in $DSH_HOME/.env',
        context: 'the route rejected a tiny request as too large: check the model\'s contextWindow in settings.yaml',
        quota: 'quota or rate limit: wait, or lower maxConcurrent and the daily budgets',
        network: 'network: check the baseURL, proxy (HTTPS_PROXY in $DSH_HOME/.env), and that the gateway is reachable',
        error: 'read the message and the startup log under $DSH_HOME/logs',
      }
      return { section: 'credentials', check, status: 'fail', detail: `${kind}: ${firstLine(errorMessage(error)).slice(0, 160)}`, fix: fixes[kind] }
    } finally {
      clearTimeout(timer)
    }
  }

  async function run(options: DoctorOptions = {}): Promise<DoctorReport> {
    const env = environment()
    const cwd = options.cwd ?? options.agent?.session.header.cwd ?? process.cwd()
    const profile = (ctx.get('profileContext') as ProfileSeam | undefined)?.name ?? 'web'
    if (options.fix === true) {
      for (const folder of WORKSPACE_FOLDERS) await mkdir(join(cwd, folder), { recursive: true })
    }
    const rows: DoctorRow[] = [
      ...checkVersion(env),
      ...checkHome(env, profile),
      ...checkWorkspace(env, cwd),
      ...checkSandbox(env),
      ...checkNativeAddon(env),
      ...checkGit(env, cwd),
      ...checkPlugins(),
      ...checkTools(),
      ...await checkSkillLock(cwd),
      ...await checkCredentials(),
    ]
    if (options.probe === true) {
      const route = options.route ?? (ctx.get('agentDefaultModel') as DefaultModelSeam | undefined)?.currentSelection()
      rows.push(route === undefined
        ? { section: 'credentials', check: 'probe', status: 'warn', detail: 'no default route to probe', fix: 'pass provider/model, for example /doctor --probe zhipu/glm-4.5' }
        : await probeRoute(route, options.agent))
    }
    return { generatedAt: new Date().toISOString(), rows, summary: summarize(rows) }
  }

  const service: DoctorService = { run, render: renderReport, internals: {} }
  ctx.provide('doctor', service)

  async function executeDoctor(invocation: CommandInvocation): Promise<CommandResult> {
    const parsed = parseDoctorInput(invocation.rawInput)
    const report = await run({ agent: invocation.agent, probe: parsed.probe, fix: parsed.fix,
      ...parsed.route === undefined ? {} : { route: parsed.route } })
    return { kind: 'success', text: renderReport(report) }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'doctor',
    description: 'Check this machine: home, workspace, sandbox, native addon, git, plugins, tool calling, credentials',
    input: { hint: '[--probe] [--fix] [provider/model]' },
    handler: executeDoctor,
  }))
}
