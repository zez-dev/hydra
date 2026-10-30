// Real composition: the loop, storage, commands, and the cron plugin booted
// from a cordis.yml through the Loader. A schedule that matches every minute
// starts a fresh session in its workspace, submits the prompt, and records the
// outcome once the scripted model answers.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as CronSessions from '@deepseek-ai/dsh-cron-sessions'
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
  root = await mkdtemp(join(tmpdir(), 'dsh-cron-loader-ws-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-cron-loader-home-'))
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
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
    "- name: '@deepseek-ai/dsh-cron-sessions'",
    '  config:',
    '    tickMs: 1000',
    '    maxConcurrent: 1',
    '    catchUp: false',
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
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-cron-sessions', CronSessions],
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

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('cron sessions real Loader composition through cordis.yml', () => {
  it('starts a fresh session for a due schedule and records the outcome', async () => {
    const ctx = await boot()
    const adapter = new MockAdapter([textResponse('all checks green')])
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
    const prompts: string[] = []
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message' && session.header.cwd === root) {
        prompts.push(event.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
      }
    })
    const added = await ctx.cronSessions.add({ name: 'minutely', cron: '* * * * *', cwd: root!, prompt: 'run the nightly checks' })
    await until(() => ctx.cronSessions.list()[0]?.lastOutcome !== undefined)
    expect(ctx.cronSessions.list()[0]).toMatchObject({ id: added.id, lastOutcome: 'completed' })
    expect(prompts).toEqual(['run the nightly checks'])
  }, 20_000)
})
