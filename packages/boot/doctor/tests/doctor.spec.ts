import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import * as Doctor from '@deepseek-ai/dsh-doctor'
import * as DoctorTools from '@deepseek-ai/dsh-doctor/tools'
import type { DoctorEnvironment, DoctorReport } from '@deepseek-ai/dsh-doctor'
import type { SkillLockService, SkillLockStatusEntry } from '@deepseek-ai/dsh-skill-lock'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let root: string | undefined
let context: Context | undefined
const signal = new AbortController().signal

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function fakeHost(cwd: string): DoctorEnvironment {
  return {
    platform: 'darwin',
    env: { DSH_HOME: cwd },
    exists: path => path === cwd || path.startsWith(join(cwd, '.dsh')),
    writable: () => true,
    readText: () => undefined,
    spawn: () => ({ status: 0, stdout: 'true\n', stderr: '' }),
    launcherPath: () => join(cwd, 'landlock-run'),
    probeLandlock: () => 'unusable',
    addonBinary: () => join(cwd, 'system.node'),
  }
}

async function setup(config: Partial<Doctor.Config> = {}) {
  root = await mkdtemp(join(tmpdir(), 'dsh-doctor-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Doctor, { probeTimeoutMs: 5000, ...config })
  await ctx.plugin(DoctorTools)
  ctx.doctor.internals = { environment: fakeHost(root) }
  return { ctx, cwd: root }
}

async function fakeAgent(ctx: Context, cwd: string, id = 'doctor-agent'): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  const agent: Agent = {
    id: SessionId(id), options: { provider: 'mock', model: 'mock' }, session, inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    whenIdle: async () => {},
    runMaintenance: async (task: (used: AbortSignal) => Promise<unknown>) => task(signal), dispose: async () => {},
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

describe('ctx.doctor', () => {
  it('reads the host through the environment set on ctx.doctor.internals', async () => {
    const { ctx, cwd } = await setup()
    const report = await ctx.doctor.run({ cwd })
    expect(report.rows.filter(row => row.section === 'sandbox')).toEqual([{ section: 'sandbox', check: 'platform runner', status: 'ok', detail: 'Seatbelt' }])
  })

  it('assembles every section into one report without touching the workspace', async () => {
    const { ctx, cwd } = await setup()
    const report = await ctx.doctor.run({ cwd })
    const sections = new Set(report.rows.map(row => row.section))
    for (const section of ['home', 'workspace', 'sandbox', 'native', 'git', 'plugins', 'tools', 'credentials']) expect(sections.has(section)).toBe(true)
    expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(report.rows.length)
  })

  it('creates the three workspace folders only under --fix', async () => {
    const { ctx, cwd } = await setup()
    await ctx.doctor.run({ cwd, fix: true })
    for (const dir of ['research', 'reports']) await expect(access(join(cwd, '.dsh', dir))).resolves.toBeUndefined()
  })

  it('lists mounted Hydra services and names the missing ones', async () => {
    const { ctx, cwd } = await setup()
    const report = await ctx.doctor.run({ cwd })
    const plugins = report.rows.filter(row => row.section === 'plugins')
    expect(plugins.find(row => row.check === 'commands')?.status).toBe('ok')
    expect(plugins.find(row => row.check === 'memory')?.status).toBe('warn')
  })

  it('probes the default route when asked and reports latency', async () => {
    const { ctx, cwd } = await setup()
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('pong')]))
    const agent = await fakeAgent(ctx, cwd)
    const report = await ctx.doctor.run({ cwd, probe: true, route: { provider: 'mock', model: 'mock' }, agent })
    const probe = report.rows.find(row => row.check === 'probe mock/mock')
    expect(probe?.status).toBe('ok')
    expect(probe?.detail).toMatch(/\d+ ms/)
  })

  it('reports a failed probe by class, never the key', async () => {
    const { ctx, cwd } = await setup()
    const report = await ctx.doctor.run({ cwd, probe: true, route: { provider: 'absent', model: 'x' } })
    const probe = report.rows.find(row => row.check === 'probe absent/x')
    expect(probe?.status).toBe('fail')
    expect(probe?.detail).not.toContain('sk-')
  })

  it('probes the deployment default route when none is named, and warns when there is none', async () => {
    const { ctx, cwd } = await setup()
    const unrouted = await ctx.doctor.run({ cwd, probe: true })
    expect(unrouted.rows.find(row => row.check === 'probe')).toMatchObject({ status: 'warn', detail: 'no default route to probe' })

    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('pong')]))
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
    const routed = await ctx.doctor.run({ cwd, probe: true })
    expect(routed.rows.find(row => row.check === 'probe mock/mock')).toMatchObject({ status: 'ok' })
  })

  it('fails a probe that outlives probeTimeoutMs as a network failure', async () => {
    const { ctx, cwd } = await setup({ probeTimeoutMs: 1000 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = ctx.doctor.run({ cwd, probe: true, route: { provider: 'mock', model: 'mock' } })
      await vi.advanceTimersByTimeAsync(1000)
      const probe = (await pending).rows.find(row => row.check === 'probe mock/mock')
      expect(probe).toMatchObject({ status: 'fail', detail: expect.stringMatching(/^network: /) as unknown })
      expect(probe?.fix).toContain('network')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads each provider key reference through the credentials service without reporting a key', async () => {
    const { ctx, cwd } = await setup()
    ctx.provide('settings', {
      get: (namespace: string) => namespace === 'llm-pi-ai'
        ? { providers: { zhipu: { apiKeyEnv: 'ZHIPU_API_KEY' }, local: {}, qwen: { apiKeyEnv: 'QWEN_API_KEY' } } }
        : undefined,
    } as never)
    ctx.provide('credentials', {
      resolve: async (ref: string) => {
        if (ref === 'QWEN_API_KEY') throw new Error('the keychain is locked')
        return ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-doctor-secret' } : undefined
      },
    } as never)
    const report = await ctx.doctor.run({ cwd })
    expect(report.rows.filter(row => row.section === 'credentials')).toEqual([
      { section: 'credentials', check: 'deepseek-official', status: 'ok', detail: 'DEEPSEEK_API_KEY resolves' },
      { section: 'credentials', check: 'zhipu', status: 'warn', detail: 'ZHIPU_API_KEY is not set', fix: 'put ZHIPU_API_KEY=... in $DSH_HOME/.env or save the key on the Models page' },
      { section: 'credentials', check: 'qwen', status: 'warn', detail: 'QWEN_API_KEY is not set', fix: 'put QWEN_API_KEY=... in $DSH_HOME/.env or save the key on the Models page' },
    ])
    expect(JSON.stringify(report)).not.toContain('sk-doctor-secret')
  })

  it('reads key references from the host environment when no credentials service is mounted', async () => {
    const { ctx, cwd } = await setup()
    ctx.doctor.internals = { environment: { ...fakeHost(cwd), env: { DSH_HOME: cwd, DEEPSEEK_API_KEY: 'sk-doctor-secret' } } }
    const report = await ctx.doctor.run({ cwd })
    expect(report.rows.find(row => row.check === 'deepseek-official')).toEqual({ section: 'credentials', check: 'deepseek-official', status: 'ok', detail: 'DEEPSEEK_API_KEY resolves' })
  })
})

describe('/doctor arguments', () => {
  it('reads --probe, --fix, and a provider/model route, and ignores other words', () => {
    expect(Doctor.parseDoctorInput('')).toEqual({ probe: false, fix: false })
    expect(Doctor.parseDoctorInput('  --fix  --probe ')).toEqual({ probe: true, fix: true })
    expect(Doctor.parseDoctorInput('please zhipu/glm-4.5')).toEqual({ probe: true, fix: false, route: { provider: 'zhipu', model: 'glm-4.5' } })
  })

  it('probes the route /doctor names', async () => {
    const { ctx, cwd } = await setup()
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('pong')]))
    const agent = await fakeAgent(ctx, cwd)
    const result = await ctx.commands.find(agent, 'doctor')!.handler({ commandId: CommandId('d2'), agent, rawInput: 'mock/mock', attachments: [], signal })
    expect((result as { text?: string }).text).toMatch(/OK +credentials +probe mock\/mock +\d+ ms/)
  })
})

describe('/doctor and the doctor tool', () => {
  it('prints the rendered table and honours --fix', async () => {
    const { ctx, cwd } = await setup()
    const agent = await fakeAgent(ctx, cwd)
    const command = ctx.commands.find(agent, 'doctor')!
    const result = await command.handler({ commandId: CommandId('d1'), agent, rawInput: '--fix', attachments: [], signal })
    expect(result.kind).toBe('success')
    expect((result as { text?: string }).text).toContain('Hydra doctor')
    await expect(access(join(cwd, '.dsh', 'reports'))).resolves.toBeUndefined()
  })

  it('returns the report as JSON from the tool and never mutates', async () => {
    const { ctx, cwd } = await setup()
    const agent = await fakeAgent(ctx, cwd)
    const result = await ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'doctor', arguments: {}, agent })
    expect(result.isError).toBe(false)
    const report = result.value as unknown as DoctorReport
    expect(Array.isArray(report.rows)).toBe(true)
    expect(report.summary).toBeDefined()
  })

  it('checks the process working directory when the tool runs without an agent', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({ signal, callId: ToolCallId('c2'), name: 'doctor', arguments: { probe: true } })
    expect(result.isError).toBe(false)
    const report = result.value as unknown as DoctorReport
    expect(report.rows.find(row => row.check === 'git repository')).toMatchObject({ status: 'ok', detail: process.cwd() })
    expect(report.rows.find(row => row.check === 'probe')).toMatchObject({ status: 'warn', detail: 'no default route to probe' })
  })
})

describe('the skills row', () => {
  function lockStub(entries: SkillLockStatusEntry[] | Error): SkillLockService {
    return {
      path: () => '/lock.json',
      status: async () => {
        if (entries instanceof Error) throw entries
        return entries
      },
      lock: async () => ({ locked: [], unknown: [] }),
      unlock: async () => false,
    }
  }

  function entry(name: string, state: SkillLockStatusEntry['state']): SkillLockStatusEntry {
    return { name, state, virtual: false }
  }

  it('leaves the section out when no lockfile service is mounted', async () => {
    const { ctx, cwd } = await setup()
    const report = await ctx.doctor.run({ cwd })
    expect(report.rows.some(row => row.section === 'skills')).toBe(false)
  })

  it('passes with no fix line when every discovered skill is locked', async () => {
    const { ctx, cwd } = await setup()
    ctx.provide('skillLock', lockStub([entry('triage', 'locked')]))
    const row = (await ctx.doctor.run({ cwd })).rows.find(candidate => candidate.section === 'skills')
    expect(row).toMatchObject({ check: 'skill lockfile', status: 'ok', detail: '1 locked, 0 drifted, 0 new' })
    expect(row?.fix).toBeUndefined()
  })

  it('warns about skills that are only new while nothing is locked yet', async () => {
    const { ctx, cwd } = await setup()
    ctx.provide('skillLock', lockStub([entry('fresh', 'new')]))
    const row = (await ctx.doctor.run({ cwd })).rows.find(candidate => candidate.section === 'skills')
    expect(row).toMatchObject({ status: 'warn', detail: '0 locked, 0 drifted, 1 new' })
  })

  it('warns with the counts and points at the lock command once anything drifted', async () => {
    const { ctx, cwd } = await setup()
    ctx.provide('skillLock', lockStub([entry('a', 'locked'), entry('b', 'drifted'), entry('c', 'new')]))
    const row = (await ctx.doctor.run({ cwd })).rows.find(candidate => candidate.section === 'skills')
    expect(row).toMatchObject({ status: 'warn', detail: '1 locked, 1 drifted, 1 new' })
    expect(row?.fix).toContain('/skills-lock lock')
  })

  it('reports an unreadable lockfile as a warning carrying the reason', async () => {
    const { ctx, cwd } = await setup()
    ctx.provide('skillLock', lockStub(new Error('skill lockfile /lock.json is unreadable: bad JSON')))
    const row = (await ctx.doctor.run({ cwd })).rows.find(candidate => candidate.section === 'skills')
    expect(row).toMatchObject({ status: 'warn' })
    expect(row?.detail).toContain('is unreadable')
  })
})
