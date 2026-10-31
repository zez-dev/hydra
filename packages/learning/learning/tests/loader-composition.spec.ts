// Real composition: both learning plugins booted from a cordis.yml through the
// Loader beside the agent loop, driven by scripted model responses. Proves
// that a finished turn with tool calls produces a stored candidate through a
// logged auxiliary request, that an approved entry reaches the next request,
// and that a /digest skill draft goes live only when published.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as Learning from '@deepseek-ai/dsh-learning'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-learning-loader-'))
  const configPath = join(root, 'cordis.yml')
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
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-memory'",
    '  config:',
    '    maxRecallBytes: 6000',
    "- name: '@deepseek-ai/dsh-learning'",
    '  config:',
    '    minToolCalls: 2',
    '    maxCandidatesPerTurn: 5',
    '    maxTranscriptBytes: 20000',
    '    maxOutputTokens: 256',
    '    timeoutMs: 5000',
    `    skillsRoot: ${JSON.stringify(join(root, 'skills'))}`,
    `    skillDraftsRoot: ${JSON.stringify(join(root, 'drafts'))}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
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
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-memory', Memory],
    ['@deepseek-ai/dsh-learning', Learning],
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

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function messagesText(messages: readonly { content: readonly { type: string; text?: string }[] }[]): string {
  return messages.map(message => message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')).join('\n')
}

describe('learning real Loader composition through cordis.yml', () => {
  it('extracts knowledge after a tool-using turn and recalls it from the next turn without a review', async () => {
    const ctx = await boot()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('done'),
      textResponse('[{"text":"probe answers ok","kind":"fact","tags":["probe"]}]'),
      textResponse('second turn'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'Probe fixture.',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId('learning-loader'), { provider: 'mock', model: 'mock' }, { cwd: root! })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'probe twice' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await until(() => ctx.memory.list({ status: 'approved' }).length === 1)
    const [candidate] = ctx.memory.list({ status: 'approved' })
    expect(candidate).toMatchObject({ text: 'probe answers ok', tags: ['probe', Memory.workspaceTag(root!)], sourceSessionId: agent.id })
    expect(adapter.requests[3]).toMatchObject({ purpose: 'learning-extract' })
    expect(agent.session.snapshotEvents().some(event => event.type === 'session/learning-request')).toBe(true)
    // Nothing reached the conversation before the review ran.
    expect(adapter.requests.slice(0, 3).some(request => messagesText(request.messages).includes('<retrieved_memory>'))).toBe(false)

    // The next request about the probe retrieves the note learned from the first turn.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'what does the probe answer?' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const recalled = messagesText(adapter.requests[4]!.messages)
    expect(recalled).toContain('<retrieved_memory>')
    expect(recalled).toContain('probe answers ok')
  }, 30_000)

  it('drafts a skill from a document with /digest and makes it live only on /learn publish', async () => {
    const ctx = await boot()
    const adapter = new MockAdapter([
      textResponse('hello'),
      textResponse(JSON.stringify({ skill: true, description: 'Release a version', body: '1. Run `make release`.', entries: [] })),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('learning-digest'), { provider: 'mock', model: 'mock' }, { cwd: root! })
    // The digest borrows the session's route, which its first request records.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await mkdir(join(root!, 'docs'))
    await writeFile(join(root!, 'docs', 'release.md'), '# Release\nTag, then run make release.\n')
    const run = (command: string, rawInput: string) =>
      ctx.commands.find(agent, command)!.handler({
        commandId: CommandId(command), agent, rawInput, attachments: [], signal: new AbortController().signal,
      })

    const digested = await run('digest', 'docs')
    expect(digested.kind).toBe('success')
    expect((digested as { text?: string }).text).toContain('1 skill draft(s) for your review: release')
    expect((await ctx.skills.list()).map(skill => skill.name)).not.toContain('release')

    expect(await run('learn', 'publish release')).toMatchObject({ kind: 'success' })
    expect(await ctx.skills.list()).toContainEqual(expect.objectContaining({ name: 'release', description: 'Release a version' }))
    await expect(readFile(join(root!, 'skills', 'release', 'source', 'release.md'), 'utf8')).resolves.toContain('make release')
  }, 30_000)
})
