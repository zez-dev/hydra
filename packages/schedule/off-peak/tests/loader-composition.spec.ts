// Real composition: the loop, the goal stack, storage, and the off-peak plugin
// booted from a cordis.yml through the Loader. A goal round claimed while every
// window is closed is deferred and queued; draining the queue resumes the same
// session and the scripted model answers its round.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as OffPeak from '@deepseek-ai/dsh-off-peak'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let root: string | undefined
let home: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, home]) if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  root = undefined
  home = undefined
})

/**
 * A window that is closed right now, whichever hour the suite runs in: it
 * covers the single minute that ended one hour ago.
 */
function closedWindow(): { start: string; end: string } {
  const past = new Date(Date.now() - 60 * 60 * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const startMinute = past.getMinutes()
  const endMinute = (startMinute + 1) % 60
  const endHour = endMinute === 0 ? (past.getHours() + 1) % 24 : past.getHours()
  return { start: `${pad(past.getHours())}:${pad(startMinute)}`, end: `${pad(endHour)}:${pad(endMinute)}` }
}

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-off-peak-loader-ws-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-off-peak-loader-home-'))
  const window = closedWindow()
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(home, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-goal'",
    "- name: '@deepseek-ai/dsh-goal-round-driver'",
    "- name: '@deepseek-ai/dsh-off-peak'",
    '  config:',
    '    enabled: true',
    '    windows:',
    `      - start: '${window.start}'`,
    `        end: '${window.end}'`,
    '    maxConcurrent: 1',
    '    finishRoundInFlight: false',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-goal', GoalService],
    ['@deepseek-ai/dsh-goal-round-driver', GoalRoundDriver],
    ['@deepseek-ai/dsh-off-peak', OffPeak],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

async function until(check: () => boolean, ms = 10_000, describe?: () => string): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) {
      throw new Error(`condition not met in time${describe === undefined ? '' : `: ${describe()}`}`)
    }
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
}

describe('off-peak real Loader composition through cordis.yml', () => {
  it('defers a goal round while the window is closed, then runs it when the queue drains', async () => {
    const ctx = await boot()
    const adapter = new MockAdapter([textResponse('indexed a shard')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('off-peak-loader'), { provider: 'mock', model: 'mock' })

    expect(ctx.offPeak.isOpen()).toBe(false)
    ctx.goals.create(agent, { objective: 'index the corpus overnight', maxGoalRounds: 4 })

    await until(
      () => ctx.goals.get(agent)?.phase === 'paused',
      10_000,
      () => `goal phase ${String(ctx.goals.get(agent)?.phase)}, queue ${String(ctx.offPeak.list().length)}, requests ${String(adapter.requests.length)}`,
    )
    await until(
      () => ctx.offPeak.list().length === 1,
      10_000,
      () => `queue ${JSON.stringify(ctx.offPeak.list())}, phase ${String(ctx.goals.get(agent)?.phase)}`,
    )
    expect(ctx.offPeak.list()[0]).toMatchObject({ kind: 'goal-round', state: 'queued' })
    expect(adapter.requests).toHaveLength(0)

    const summary = await ctx.offPeak.drain()
    expect(summary).toMatchObject({ started: 1, done: 1 })
    await until(() => adapter.requests.length > 0)
    expect(ctx.offPeak.list()[0]).toMatchObject({ state: 'done' })
  }, 20_000)
})
