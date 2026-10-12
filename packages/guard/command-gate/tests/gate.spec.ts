import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import * as CommandGate from '@deepseek-ai/dsh-command-gate'
import type { Config } from '@deepseek-ai/dsh-command-gate'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

const signal = new AbortController().signal
const WORKSPACE = '/work/repo'

/** Commands the fake shell actually ran, so a denial is visible as absence. */
let ran: string[] = []

/** A stand-in shell tool with the same `command`/`workdir` arguments the real one takes. */
const shellTool = defineTool({
  name: 'bash',
  description: 'run a command',
  parameters: {
    command: { type: 'string', required: true },
    workdir: { type: 'string' },
  },
  output: {
    schema: { type: 'json' },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  execute: async (args) => {
    ran.push(args.command)
    return { ok: true }
  },
})

async function setup(config: Partial<Config> = {}, approval?: 'service' | 'never'): Promise<Context> {
  ran = []
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  if (approval !== undefined) {
    await ctx.plugin(ApprovalService, { policy: approval === 'never' ? 'never' : 'ask' })
  }
  await ctx.plugin(CommandGate, {
    mode: 'confirm', unattendedMode: 'deny', allow: [], denyExtra: [], temporaryRoots: [], ...config,
  })
  ctx.tools.register(shellTool)
  return ctx
}

/** Register a stand-in agent over `session`; `unregister` disposes it as its owner would. */
async function registerAgent(ctx: Context, session: Session): Promise<{ agent: Agent; unregister: () => Promise<void> }> {
  const scope = ctx.plugin(() => {})
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  const registration = ctx.agents.register(agent)
  await registration
  return { agent, unregister: async () => { await registration() } }
}

async function fakeAgent(ctx: Context, id = 'gate-agent', meta: { cwd?: string } = { cwd: WORKSPACE }): Promise<Agent> {
  return (await registerAgent(ctx, ctx.sessions.create(SessionId(id), { meta }))).agent
}

/** The text `/commands-gate` prints for an agent. */
async function gateReport(ctx: Context, agent: Agent): Promise<string> {
  const result = await ctx.commands.find(agent, 'commands-gate')!.handler({
    commandId: CommandId('c1'), agent, rawInput: '', attachments: [], signal,
  })
  return (result as { text: string }).text
}

/** Run one command through the registry, the way a model call would. */
async function run(ctx: Context, agent: Agent, command: string, workdir?: string) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId('c1'),
    name: 'bash',
    agent,
    arguments: { command, ...workdir === undefined ? {} : { workdir } },
  })
}

describe('the gate decides inside the executor', () => {
  it('stops a denied command before the tool body runs', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    const result = await run(ctx, agent, 'rm -rf /etc')
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('outside the workspace')
    expect(ran).toEqual([])
  })

  it('lets an ordinary command through untouched', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    const result = await run(ctx, agent, 'pnpm run build')
    expect(result.isError).toBe(false)
    expect(ran).toEqual(['pnpm run build'])
  })

  it('judges the command against its own workdir', async () => {
    const ctx = await setup({ temporaryRoots: ['/work/repo/scratch'] })
    const agent = await fakeAgent(ctx)
    expect((await run(ctx, agent, 'rm -rf build', '/work/repo/scratch')).isError).toBe(false)
    expect(ran).toEqual(['rm -rf build'])
  })

  it('judges a relative workdir against the session workspace', async () => {
    const ctx = await setup({ temporaryRoots: ['/work/repo/scratch'] })
    const agent = await fakeAgent(ctx)
    expect((await run(ctx, agent, 'rm -rf build', 'scratch')).isError).toBe(false)
    expect((await run(ctx, agent, 'rm -rf build', 'src')).isError).toBe(true)
    expect(ran).toEqual(['rm -rf build'])
  })

  it('leaves a call whose arguments are not an object to the tool', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    for (const args of [null, 'rm -rf /etc']) {
      const result = await ctx.tools.execute({ signal, callId: ToolCallId('c3'), name: 'bash', agent, arguments: args })
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('invalid arguments')
    }
    expect(agent.session.snapshotEvents().some(event => event.type === 'command-gate/blocked')).toBe(false)
    expect(ran).toEqual([])
  })

  it('leaves a call without a session workspace to the tool', async () => {
    const ctx = await setup()
    const withoutWorkspace = await fakeAgent(ctx, 'no-workspace', {})
    expect((await run(ctx, withoutWorkspace, 'git reset --hard')).isError).toBe(false)
    const withoutAgent = await ctx.tools.execute({
      signal, callId: ToolCallId('c4'), name: 'bash', arguments: { command: 'git reset --hard' },
    })
    expect(withoutAgent.isError).toBe(false)
    expect(ran).toEqual(['git reset --hard', 'git reset --hard'])
  })

  it('leaves tools without a command argument alone', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    ctx.tools.register(defineTool({
      name: 'note',
      description: 'note',
      parameters: { text: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: () => [] },
      execute: async () => ({ ok: true }),
    }))
    const result = await ctx.tools.execute({
      signal, callId: ToolCallId('c2'), name: 'note', agent, arguments: { text: 'rm -rf /etc' },
    })
    expect(result.isError).toBe(false)
  })

  it('passes everything through when the mode is off', async () => {
    const ctx = await setup({ mode: 'off' })
    const agent = await fakeAgent(ctx)
    expect((await run(ctx, agent, 'rm -rf /etc')).isError).toBe(false)
    expect(ran).toEqual(['rm -rf /etc'])
  })
})

describe('a confirm verdict without a human', () => {
  it('denies when no approval service is composed and unattendedMode is deny', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    const result = await run(ctx, agent, 'git reset --hard')
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/commit|stash|rollback/i)
    expect(ran).toEqual([])
  })

  it('denies when the session policy already rejects every ask', async () => {
    const ctx = await setup({}, 'never')
    const agent = await fakeAgent(ctx)
    expect((await run(ctx, agent, 'git clean -fd')).isError).toBe(true)
    expect(ran).toEqual([])
  })

  it('raises the approval when unattendedMode is confirm and a channel exists', async () => {
    const ctx = await setup({ unattendedMode: 'confirm' }, 'service')
    const agent = await fakeAgent(ctx)
    const asked: string[] = []
    ctx.on('approval/request', (request: ApprovalRequest): Promise<ApprovalOutcome> => {
      asked.push(request.reason ?? '')
      return Promise.resolve('allowed-once')
    })
    agent.session.append('turn/start', { turn: 1 })
    const result = await run(ctx, agent, 'git reset --hard')
    expect(result.isError).toBe(false)
    expect(asked.join(' ')).toMatch(/uncommitted/i)
    expect(ran).toEqual(['git reset --hard'])
  })

  it('denies a confirm verdict outright under mode deny', async () => {
    const ctx = await setup({ mode: 'deny' }, 'service')
    const agent = await fakeAgent(ctx)
    agent.session.append('turn/start', { turn: 1 })
    expect((await run(ctx, agent, 'git reset --hard')).isError).toBe(true)
    expect(ran).toEqual([])
  })
})

describe('the block record', () => {
  it('logs each refusal to the session and lists it in /commands-gate', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await run(ctx, agent, 'rm -rf /etc')
    const logged = agent.session.snapshotEvents().filter(event => event.type === 'command-gate/blocked')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).toMatchObject({ tool: 'bash', rule: 'rm-destructive', verdict: 'deny' })

    const command = ctx.commands.find(agent, 'commands-gate')
    const result = await command!.handler({
      commandId: CommandId('c1'), agent, rawInput: '', attachments: [], signal,
    })
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text: string }).text).toContain('rm -rf /etc')
    expect((result as { text: string }).text).toContain('confirm')
  })

  it('reports an empty history before anything is blocked', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    expect(await gateReport(ctx, agent)).toContain('Nothing blocked')
  })

  it('lists the twenty most recent refusals while the log keeps every one', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    for (let index = 1; index <= 21; index += 1) await run(ctx, agent, `rm -rf /etc/app${String(index)}`)
    const report = await gateReport(ctx, agent)
    const listed = report.split('\n').filter(line => line.startsWith('  ['))
    expect(report).toContain('Blocked 20:')
    expect(listed).toHaveLength(20)
    expect(listed[0]).toBe('  [rm-destructive] rm -rf /etc/app2')
    expect(listed.at(-1)).toBe('  [rm-destructive] rm -rf /etc/app21')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'command-gate/blocked')).toHaveLength(21)
  })

  it('forgets a session\'s refusals once its agent is disposed', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('gate-agent'), { meta: { cwd: WORKSPACE } })
    const first = await registerAgent(ctx, session)
    await run(ctx, first.agent, 'rm -rf /etc')
    expect(await gateReport(ctx, first.agent)).toContain('Blocked 1:')
    await first.unregister()
    const resumed = await registerAgent(ctx, session)
    expect(await gateReport(ctx, resumed.agent)).toContain('Nothing blocked in this session.')
  })
})

describe('the deployment policy', () => {
  it('denies a configured prefix however it was spaced and ignores a blank one', async () => {
    const ctx = await setup({ denyExtra: ['  terraform   destroy ', '   '] })
    const agent = await fakeAgent(ctx)
    const refused = await run(ctx, agent, 'terraform destroy -auto-approve')
    expect(refused.isError).toBe(true)
    expect((refused.content[0] as { text: string }).text).toContain('`terraform destroy` is blocked')
    expect((await run(ctx, agent, 'terraform plan')).isError).toBe(false)
    expect(ran).toEqual(['terraform plan'])
  })

  it('prints the allowed rules and temporary roots in /commands-gate', async () => {
    const ctx = await setup({ allow: ['git-clean', 'chmod-recursive'], temporaryRoots: ['/tmp/scratch'] })
    const agent = await fakeAgent(ctx)
    expect(await gateReport(ctx, agent)).toBe([
      'Command gate: confirm (unattended: deny)',
      'Allowed rules: git-clean, chmod-recursive',
      'Temporary roots: /tmp/scratch',
      '',
      'Nothing blocked in this session.',
    ].join('\n'))
  })

  it('prints only the mode in /commands-gate when the gate is off', async () => {
    const ctx = await setup({ mode: 'off' })
    const agent = await fakeAgent(ctx)
    expect(await gateReport(ctx, agent)).toBe('Command gate: off\n\nNothing blocked in this session.')
  })
})
