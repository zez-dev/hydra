// Real composition: the goal stack and the digest plugin booted from
// a cordis.yml through the Loader; `/report` writes the day's report with every
// section into the workspace.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as CommandGoal from '@deepseek-ai/dsh-command-goal'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Digest from '@deepseek-ai/dsh-digest'
import { localDateKey } from '@deepseek-ai/dsh-util-time'
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

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-digest-loader-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-digest-home-'))
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
    "- name: '@deepseek-ai/dsh-goal'",
    "- name: '@deepseek-ai/dsh-goal-round-driver'",
    "- name: '@deepseek-ai/dsh-tool-goal'",
    "- name: '@deepseek-ai/dsh-command-goal'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(home, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-digest'",
    '  config: {}',
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
    ['@deepseek-ai/dsh-goal', GoalService],
    ['@deepseek-ai/dsh-goal-round-driver', GoalRoundDriver],
    ['@deepseek-ai/dsh-tool-goal', ToolGoal],
    ['@deepseek-ai/dsh-command-goal', CommandGoal],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-digest', Digest],
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

describe('digest real Loader composition through cordis.yml', () => {
  it('/report writes the day report with every section for the session workspace', async () => {
    const ctx = await boot()
    const cwd = root!
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
    const agent = await ctx.agentLoop.create(SessionId('digest-loader'), { provider: 'mock', model: 'mock' }, { cwd })
    const signal = new AbortController().signal
    expect((await ctx.commands.find(agent, 'goal')!.handler({ commandId: CommandId('g'), agent, rawInput: 'harden the release', attachments: [], signal })).kind).toBe('success')
    ctx.goals.disarm(agent)
    const result = await ctx.commands.find(agent, 'report')!.handler({ commandId: CommandId('d'), agent, rawInput: '', attachments: [], signal })
    expect(result.kind).toBe('success')
    const text = await readFile(join(cwd, '.dsh', 'reports', `${localDateKey(new Date())}.md`), 'utf8')
    for (const heading of ['## Goals', '## Tickets', '## Checkpoints', '## Memory', '## Spend', '## Cron runs', '## Research breakthroughs']) {
      expect(text).toContain(heading)
    }
    expect(text).toContain('harden the release')
    expect(text).toContain('## Tickets\n_not mounted_')
  }, 30_000)
})
