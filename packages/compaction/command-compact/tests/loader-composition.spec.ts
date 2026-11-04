import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {
  CompactionId,
  CompactionEngine,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const COMPACTION_ID = CompactionId('loader-command-compact-test')

const RESULT: CompactionResult = {
  compactionId: COMPACTION_ID,
  startSeq: SessionSeq(1),
  summarySeq: SessionSeq(2),
  endSeq: SessionSeq(3),
  summary: [{ type: 'text', text: 'loader summary' }],
  shadowedRange: { start: SessionSeq(3), end: SessionSeq(8) },
  shadowedSeqs: [SessionSeq(3), SessionSeq(5), SessionSeq(8)],
  shadowedTokenCount: 99,
}

class LoaderCompactionEngine extends CompactionEngine {
  override compactIfNeeded(
    _agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }

  override compactRegion(): Promise<CompactionResult> {
    return Promise.resolve(RESULT)
  }

  override compactNow(
    agent: ManualCompactAgentContext,
    _signal: AbortSignal,
    sourceCommandId?: Parameters<CompactionEngine['compactNow']>[2],
  ): Promise<CompactionResult | null> {
    const operationIds = {
      compactionId: RESULT.compactionId,
      ...sourceCommandId === undefined ? {} : { sourceCommandId },
    }
    agent.session.append('compaction/start', { ...operationIds, turn: null })
    agent.session.append('compaction/summary', {
      ...operationIds,
      summary: RESULT.summary,
      shadowedRange: RESULT.shadowedRange,
      shadowedSeqs: RESULT.shadowedSeqs,
      shadowedTokenCount: RESULT.shadowedTokenCount,
      provider: 'loader-test',
      model: 'loader-test',
    })
    agent.session.append('compaction/end', { ...operationIds, turn: null })
    return Promise.resolve({ ...RESULT, ...operationIds })
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a test-only cordis.yml that lists each module by name, in order,
 * through the real Loader.
 * @param modules - module per package name; the Loader may import nothing else.
 * @returns the loaded root context, disposed after the test.
 */
async function loadComposition(modules: ReadonlyMap<string, unknown>): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-command-compact-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...[...modules.keys()].map(name => `- name: '${name}'`), ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('command-compact real Loader composition', () => {
  it('discovers and executes /compact through the assembled command plane', async () => {
    const loaded = await loadComposition(new Map<string, unknown>([
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@test/compact-backend', LoaderCompactionEngine],
      ['@deepseek-ai/dsh-command-compact', commandCompact],
    ]))

    const session = Session.create(SessionId('loader-command-compact'))
    const agent = {
      session,
      status: 'idle',
      options: {},
      reserveTurnAdmission: () => () => undefined,
    } as unknown as Agent
    expect(loaded.commands.list(agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-command-compact',
      name: 'compact',
      description: 'Compact older conversation history',
    })
    const execution = await loaded.commands.execute(agent, '/compact', [], new AbortController().signal)
    if (execution === undefined) throw new Error('Loader composition did not resolve /compact')
    expect(execution.result).toEqual({
      kind: 'success',
      text: 'Compacted 3 history items (~99 tokens).',
      sourceEventSeq: RESULT.summarySeq,
    })
    expect(session.snapshotEvents().map(event => ({ type: event.type, data: event.data }))).toEqual([
      {
        type: 'command/run',
        data: {
          commandId: execution.commandId,
          name: 'compact',
          args: '',
          source: { kind: 'user' },
        },
      },
      {
        type: 'compaction/start',
        data: {
          compactionId: COMPACTION_ID,
          sourceCommandId: execution.commandId,
          turn: null,
        },
      },
      {
        type: 'compaction/summary',
        data: {
          compactionId: COMPACTION_ID,
          sourceCommandId: execution.commandId,
          summary: RESULT.summary,
          shadowedRange: RESULT.shadowedRange,
          shadowedSeqs: RESULT.shadowedSeqs,
          shadowedTokenCount: RESULT.shadowedTokenCount,
          provider: 'loader-test',
          model: 'loader-test',
        },
      },
      {
        type: 'compaction/end',
        data: {
          compactionId: COMPACTION_ID,
          sourceCommandId: execution.commandId,
          turn: null,
        },
      },
      {
        type: 'command/done',
        data: {
          commandId: execution.commandId,
          kind: 'success',
          text: 'Compacted 3 history items (~99 tokens).',
          sourceEventSeq: RESULT.summarySeq,
        },
      },
    ])
    expect(session.surface.nodes).toEqual([])
    expect(session.deriveMessages()).toEqual([])
  })

  it('settles a /compact stopped during summarization as Compaction cancelled.', async () => {
    const loaded = await loadComposition(new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-token-meter', TokenMeter],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-agent-loop', AgentLoop],
      ['@deepseek-ai/dsh-compaction-basic', BasicCompactionEngine],
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-command-compact', commandCompact],
    ]))
    // The turn's answer, then a summarization request that streams until aborted.
    const adapter = new MockAdapter([textResponse('noted'), 'hang'])
    loaded.llm.registerAdapter(['mock'], adapter)
    const agent = await loaded.agentLoop.create(SessionId('loader-command-compact-stop'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'older conversation history '.repeat(60) }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const execution = loaded.commands.execute(agent, '/compact', [], new AbortController().signal)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) }, { timeout: 5_000 })
    // Compaction runs as agent maintenance, so the Session reports idle.
    expect(agent.status).toBe('idle')
    // The Session Controller's `session.cancel` makes exactly this call.
    agent.cancel({ kind: 'user' }, { keepInbox: true })

    const settled = await execution
    if (settled === undefined) throw new Error('Loader composition did not resolve /compact')
    expect(settled.result).toEqual({ kind: 'error', text: 'Compaction cancelled.' })
    const lifecycleTypes = new Set(['command/run', 'compaction/start', 'compaction/summary', 'compaction/end', 'command/done'])
    const lifecycle = agent.session.snapshotEvents().filter(event => lifecycleTypes.has(event.type))
    expect(lifecycle.map(event => event.type)).toEqual([
      'command/run', 'compaction/start', 'compaction/end', 'command/done',
    ])
    expect(lifecycle[1]?.data).toMatchObject({ sourceCommandId: settled.commandId, turn: null })
    expect(lifecycle[2]?.data).toMatchObject({ sourceCommandId: settled.commandId, error: expect.any(String) as string })
    expect(lifecycle[3]?.data).toEqual({ commandId: settled.commandId, kind: 'error', text: 'Compaction cancelled.' })
  })
})
