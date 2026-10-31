// Real composition: both evidence-guard rows booted from a cordis.yml through
// the Loader beside the agent loop and a test-only tool, driven by a scripted
// adapter. Proves the evidence standard reaches the model's system prompt and
// a turn with a tool call ends with a logged review that the next request carries.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as EvidenceGuard from '../src/index.ts'
import * as EvidenceReview from '../src/review.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** A test-only plugin that registers one tool, so a turn has a call to review. */
const ProbeTools = {
  name: 'probe-tools',
  inject: ['tools'],
  apply(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'probe',
      description: 'Probe the workspace.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: 'ok' }],
      },
      execute: () => Promise.resolve({ ok: true }),
    }))
  },
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-evidence-guard-loader-'))
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
    '- name: probe-tools',
    "- name: '@deepseek-ai/dsh-evidence-guard'",
    "- name: '@deepseek-ai/dsh-evidence-guard/review'",
    '  config:',
    '    reviewAfterToolCalls: 1',
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
    ['probe-tools', ProbeTools],
    ['@deepseek-ai/dsh-evidence-guard', EvidenceGuard],
    ['@deepseek-ai/dsh-evidence-guard/review', EvidenceReview],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('evidence guard real Loader composition through cordis.yml', () => {
  it('puts the evidence standard in the system prompt and reviews a turn with a tool call', async () => {
    const ctx = await boot()
    const adapter = new MockAdapter([toolCallResponse('c1', 'probe', {}), textResponse('first answer'), textResponse('reviewed answer')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('evidence-guard-loader'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'check the workspace' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(JSON.stringify(adapter.requests[0]!.messages[0])).toContain(EvidenceGuard.EVIDENCE_STANDARD_TEXT)
    const review = agent.session.snapshotEvents()
      .find(event => event.type === 'user/message' && event.data.source.kind === EvidenceReview.REVIEW_SOURCE_KIND)
    expect(review).toBeDefined()
    expect(adapter.requests).toHaveLength(3)
    expect(JSON.stringify(adapter.requests[2]!.messages.at(-1))).toContain('Before you finish, check your work:')
  })
})
