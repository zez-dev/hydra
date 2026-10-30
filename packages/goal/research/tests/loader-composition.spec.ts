// Real composition: the research goal booted from a cordis.yml through the
// Loader beside the goal stack, memory, learning, and the agent loop, driven by
// scripted model responses. Proves that a `/research` round's `journal`
// breakthrough is recalled into the next request, that a `run_experiment`
// call lands an experiment with metrics and triggers hypothesis scoring the
// next round reads, and that a new session in the same workspace picks the
// journal up in its first request.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as CommandGoal from '@deepseek-ai/dsh-command-goal'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as Learning from '@deepseek-ai/dsh-learning'
import * as Research from '@deepseek-ai/dsh-research'
import * as ResearchTools from '@deepseek-ai/dsh-research/tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * The scripted adapter: every learning-extraction request yields one auto dead
 * end, every scoring request scores the journal's first hypothesis 0.9.
 */
class PurposeAdapter extends MockAdapter {
  hypothesisId: () => string | undefined = () => undefined
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'learning-extract') {
      this.requests.push(options)
      yield* textResponse('[{"kind":"dead_end","text":"Dropout above 0.5 diverges"}]')
      return
    }
    if (options.purpose === 'research-score') {
      this.requests.push(options)
      const id = this.hypothesisId()
      yield* textResponse(id === undefined ? '[]' : `[{"hypothesisId":"${id}","score":0.9,"reason":"loss fell to 0.25"}]`)
      return
    }
    yield* super.stream(options)
  }
}

let root: string | undefined
let context: Context | undefined
const warnings: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-research-loader-'))
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
    "- name: '@deepseek-ai/dsh-goal'",
    "- name: '@deepseek-ai/dsh-goal-round-driver'",
    "- name: '@deepseek-ai/dsh-tool-goal'",
    "- name: '@deepseek-ai/dsh-command-goal'",
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
    '    minToolCalls: 1',
    '    maxCandidatesPerTurn: 5',
    '    maxTranscriptBytes: 24000',
    '    maxOutputTokens: 512',
    '    timeoutMs: 60000',
    `    skillsRoot: ${JSON.stringify(join(root, 'skills'))}`,
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-shell-env'",
    "- name: '@deepseek-ai/dsh-bash-local'",
    '  config:',
    '    timeoutMs: 10000',
    '    graceMs: 200',
    "- name: '@deepseek-ai/dsh-research'",
    '  config:',
    '    dir: .dsh/research',
    '    maxRecallBytes: 8000',
    '    recentExperiments: 10',
    '    scoring:',
    '      enabled: true',
    '      maxOutputTokens: 256',
    '      timeoutMs: 60000',
    '      provider: mock',
    '      model: score-mock',
    '    maxExperimentMs: 60000',
    '    maxOutputBytes: 2000',
    "- name: '@deepseek-ai/dsh-research/tools'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  const warn = ctx.logger.warn.bind(ctx.logger)
  ctx.logger.warn = ((...args: unknown[]) => { warnings.push(String(args[0])); warn(...args as [string]) }) as typeof ctx.logger.warn
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
    ['@deepseek-ai/dsh-goal', GoalService],
    ['@deepseek-ai/dsh-goal-round-driver', GoalRoundDriver],
    ['@deepseek-ai/dsh-tool-goal', ToolGoal],
    ['@deepseek-ai/dsh-command-goal', CommandGoal],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-memory', Memory],
    ['@deepseek-ai/dsh-learning', Learning],
    ['@deepseek-ai/dsh-research', Research],
    ['@deepseek-ai/dsh-research/tools', ResearchTools],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-shell-env', BashEnvPlugin],
    ['@deepseek-ai/dsh-bash-local', LocalBashExecutor],
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
  const spillDir = join(root, 'spill')
  await mkdir(spillDir, { recursive: true })
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  return ctx
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function messagesText(messages: readonly { content: readonly { type: string; text?: string }[] }[]): string {
  return messages.map(message => message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')).join('\n')
}

describe('research goal real Loader composition through cordis.yml', () => {
  it('records a breakthrough in a round, recalls it next request, and a new session in the workspace starts from it', async () => {
    const ctx = await boot()
    const adapter = new PurposeAdapter([
      // Round 1 of the first session: a hypothesis, a measured experiment, a breakthrough, then stop.
      toolCallResponse('c0', 'journal', { action: 'hypothesis', text: 'Depth matters' }),
      toolCallResponse('c0b', 'run_experiment', {
        title: 'baseline', command: 'node -e "console.log(\'loss=0.25\')"', metrics: [{ name: 'loss', regex: 'loss=([0-9.]+)' }],
      }),
      toolCallResponse('c1', 'journal', { action: 'breakthrough', text: 'Scaling law holds at depth 5' }),
      textResponse('recorded'),
      // Round 2 and later: nothing.
      textResponse('nothing more'),
      textResponse('nothing more'),
      textResponse('nothing more'),
      textResponse('nothing more'),
      // Second session, round 1.
      textResponse('continuing'),
      textResponse('nothing more'),
      textResponse('nothing more'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const first = await ctx.agentLoop.create(SessionId('research-first'), { provider: 'mock', model: 'mock' }, { cwd: root! })
    const command = ctx.commands.find(first, 'research')!
    const started = await command.handler({ commandId: CommandId('c1'), agent: first, rawInput: 'Find the scaling law --slug scaling --criteria "error below 1%"', attachments: [], signal: new AbortController().signal })
    expect(started.kind).toBe('success')

    const store = ctx.research.storeFor(root!)
    adapter.hypothesisId = () => store.get('scaling')?.hypotheses[0]?.id
    await until(() => (store.get('scaling')?.breakthroughs.length ?? 0) === 1)
    await until(() => adapter.requests.length >= 4)
    ctx.goals.disarm(first)
    await first.whenIdle()
    await until(() => adapter.requests.some(request => request.purpose === 'learning-extract'), 8000).catch((error: unknown) => {
      throw new Error(`${String(error)}; warnings: ${warnings.join(' | ') || 'none'}`)
    })
    await until(() => (store.get('scaling')?.deadEnds.length ?? 0) === 1, 8000)

    const firstRequest = messagesText(adapter.requests[0]!.messages)
    expect(firstRequest).toContain('Role: researcher')
    expect(firstRequest).toContain('<research_journal>')
    // A later round starts from the journal with the breakthrough recorded in round 1.
    const laterRounds = adapter.requests.filter(request => request.purpose === undefined
      && request.messages.filter(message => message.role === 'user' && message.source?.kind === 'goal').length >= 2)
    expect(laterRounds.length).toBeGreaterThan(0)
    expect(messagesText(laterRounds[0]!.messages)).toContain('Scaling law holds at depth 5')
    // The measured experiment landed with its metric, and the scoring request re-ranked the hypothesis.
    expect(store.get('scaling')?.experiments[0]).toMatchObject({ title: 'baseline', metrics: { loss: 0.25 }, source: 'model' })
    expect(adapter.requests.filter(request => request.purpose === 'research-score')[0]).toMatchObject({ model: 'score-mock' })
    expect(store.get('scaling')?.hypotheses[0]).toMatchObject({ text: 'Depth matters', score: 0.9, scoreReason: 'loss fell to 0.25' })
    // The round after the scoring request ranks the hypothesis by its new score.
    expect(laterRounds.some(request => messagesText(request.messages).includes('score 0.9: loss fell to 0.25'))).toBe(true)
    expect(store.get('scaling')?.deadEnds[0]).toMatchObject({ text: 'Dropout above 0.5 diverges', source: 'auto' })

    const second = await ctx.agentLoop.create(SessionId('research-second'), { provider: 'mock', model: 'mock' }, { cwd: root! })
    const before = adapter.requests.length
    const resumed = await ctx.commands.find(second, 'research')!.handler({ commandId: CommandId('c2'), agent: second, rawInput: 'whatever --slug scaling', attachments: [], signal: new AbortController().signal })
    expect(resumed.kind).toBe('success')
    await until(() => adapter.requests.length > before)
    ctx.goals.disarm(second)
    await second.whenIdle()
    const secondFirst = messagesText(adapter.requests[before]!.messages)
    expect(secondFirst).toContain('<research_journal>')
    expect(secondFirst).toContain('Scaling law holds at depth 5')
    expect(store.get('scaling')?.sessions).toEqual(['research-first', 'research-second'])
  }, 40_000)
})
