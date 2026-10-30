/**
 * The long-session stress harness: the production composition (loop, meter,
 * pruner, compaction, auto-continue) driven for many turns against a
 * provider that behaves like a real one and unlike the harness's guess.
 * Shared by the spec and by profiling runs.
 * @module
 */
import { appendFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, resolveRetryPolicy, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, RequestMessage, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import * as AutoContinue from '@deepseek-ai/dsh-auto-continue'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * A long session against a provider that behaves like a real one and unlike
 * the harness's guess: it counts tokens denser than the heuristic by a factor
 * that varies per request, reports usage, refuses any request whose counted
 * input plus output cap exceeds its window, spends part of every output cap
 * on reasoning, cuts long answers at the cap, and writes checkpoints of a
 * real size. The harness must keep every turn completing for as long as
 * the session runs.
 */

/** Append one report line to the file `DSH_STRESS_REPORT` names, when set; the runner hides passing output otherwise. */
export function reportLine(line: string): void {
  const path = process.env['DSH_STRESS_REPORT']
  if (path !== undefined && path.length > 0) appendFileSync(path, `${line}\n`)
  console.log(line)
}

/**
 * Price one request message with the meter's heuristic; the summarizer's
 * request-only instruction prices as the user message it stands for.
 * @param ctx - context carrying the token meter.
 * @param message - a durable message or a request-only user input.
 * @returns the heuristic token count.
 */
function priceMessage(ctx: Context, message: RequestMessage): number {
  return ctx.tokenMeter.estimateMessage(message.source === undefined
    ? createUserMessage({ content: message.content, source: { kind: 'user' } })
    : message)
}

/** Deterministic pseudo-random numbers so a run is reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/** Provider route parameters for one stress run. */
export interface RouteShape {
  /** Real context window the provider enforces. */
  readonly window: number
  /** Window the harness is told about (what the user configures). */
  readonly configuredWindow: number
  /** Default output cap of the route. */
  readonly cap: number
  /** Reasoning tokens every response spends before its answer. */
  readonly think: number
  /** Density range: provider tokens per heuristic token, uniformly drawn per request. */
  readonly density: readonly [number, number]
  /** Tokens a checkpoint takes, reasoning excluded. */
  readonly checkpoint: number
  /** Transient faults by conversation request ordinal, the way an unreliable provider or network fails. */
  readonly faults?: (request: number) => ProviderFault | undefined
}

/** One transient provider failure. */
export type ProviderFault = 'server' | 'rate-limit' | 'disconnect' | 'empty'

/** Metrics of one run, for the report and the assertions. */
export interface RunReport {
  turns: number
  failedTurns: { turn: number; reason: string }[]
  conversationRequests: number
  summaryRequests: number
  refusedConversation: number
  refusedSummary: number
  cutSummaries: number
  cutAnswers: number
  continuations: number
  checkpoints: number
  /** Requests whose output cap was shrunk below the route's cap, with the caps asked for. */
  shrunkCaps: number[]
  maxSurfaceTokens: number
  events: number
  msPerTurnFirstQuarter: number
  msPerTurnLastQuarter: number
  /** Mean milliseconds per turn in each quarter of the run, so growth with the log shows. */
  msPerTurnByQuarter: number[]
  /** Heap in use at the end of the run, in MiB. */
  heapMb: number
  /** Transient faults injected, by kind. */
  faults: Record<string, number>
}

class StressProvider extends LlmAdapter {
  readonly refusedConversation: GenerateOptions[] = []
  readonly refusedSummary: GenerateOptions[] = []
  conversationRequests = 0
  summaryRequests = 0
  cutSummaries = 0
  cutAnswers = 0
  /** Faults injected, by kind. */
  readonly faults = new Map<ProviderFault, number>()
  /** The newest task number seen in a request; a task message condensed into a checkpoint keeps its number here. */
  private lastTurn = 0
  /** Reads issued for the current task, counted here because a checkpoint may have replaced their tool results. */
  private readsDone = 0
  private readonly random: () => number

  constructor(
    private readonly ctx: Context,
    readonly shape: RouteShape,
    seed: number,
    /** Reads the model asks for in a turn, by turn number. */
    private readonly readsInTurn: (turn: number) => number,
    /** Answer tokens the final response of a turn needs, by turn number. */
    private readonly answerTokens: (turn: number) => number,
  ) {
    super()
    this.random = prng(seed)
  }

  /** The shipped retry policy with its backoff shortened, so a run spends its time on turns, not on waiting. */
  override providerRetryPolicy(): ResolvedRetryPolicy {
    return resolveRetryPolicy({ mode: 'normal', backoff: { initialDelayMs: 2, maxDelayMs: 8 } }, 'stress retryPolicy')
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.shape.configuredWindow },
      defaultMaxTokens: this.shape.cap,
    })
  }

  private priced(options: GenerateOptions): number {
    const [low, high] = this.shape.density
    const density = low + (high - low) * this.random()
    const estimated = options.messages.reduce((sum, message) => sum + priceMessage(this.ctx, message), 0)
    return Math.round(estimated * density)
  }

  /** Fail one request the way a provider or the network does. */
  private * fail(fault: ProviderFault): Generator<StreamChunk> {
    switch (fault) {
      case 'server':
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 502 bad gateway', code: 'SERVER' } } }
        return
      case 'rate-limit':
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 429 too many requests', code: 'RATE_LIMIT', providerRetryAfterMs: 20 } } }
        return
      case 'disconnect':
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Result for task' }
        throw new Error('socket hang up')
      case 'empty':
        // Real adapters raise this themselves when a completion carries nothing.
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'the completion carried no content', code: 'EMPTY_RESPONSE' } } }
        return
      default:
        return
    }
  }

  private * refuse(input: number, maxTokens: number): Generator<StreamChunk> {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `This model's maximum context length is ${this.shape.window} tokens. However, you requested `
            + `${maxTokens} output tokens and your prompt contains at least ${input} input tokens`,
          code: CONTEXT_WINDOW_EXCEEDED_CODE,
        },
      },
    }
  }

  private * answer(input: number, text: string, needed: number, maxTokens: number, reasoning: number): Generator<StreamChunk> {
    const cut = needed + reasoning > maxTokens
    const visible = cut ? text.slice(0, Math.max(0, Math.floor(text.length * Math.max(0, maxTokens - reasoning) / needed))) : text
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'considering '.repeat(Math.ceil(reasoning / 2)) } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: visible } }
    const outputTokens = cut ? maxTokens : needed + reasoning
    yield { type: 'usage', usage: { inputTokens: input, outputTokens, reasoningTokens: reasoning } }
    yield { type: 'finish', reason: { kind: cut ? 'max-tokens' : 'stop' } }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const input = this.priced(options)
    const maxTokens = options.maxTokens ?? this.shape.cap
    const trailing = options.messages.at(-1)?.content.map(block => (block.type === 'text' ? block.text : '')).join('') ?? ''
    if (trailing.includes('acting as a compaction engine')) {
      this.summaryRequests += 1
      if (input + maxTokens > this.shape.window) {
        this.refusedSummary.push(options)
        yield * this.refuse(input, maxTokens)
        return
      }
      const cut = this.shape.checkpoint + this.shape.think > maxTokens
      if (cut) this.cutSummaries += 1
      const body = `## Primary Request and Intent\n${'the user asked for work on the files and the model did it '.repeat(Math.ceil(this.shape.checkpoint / 12))}`
      yield * this.answer(input, cut ? body.slice(0, 40) : body, this.shape.checkpoint, maxTokens, this.shape.think)
      return
    }
    this.conversationRequests += 1
    const fault = this.shape.faults?.(this.conversationRequests)
    if (fault !== undefined) {
      this.faults.set(fault, (this.faults.get(fault) ?? 0) + 1)
      yield * this.fail(fault)
      return
    }
    if (input + maxTokens > this.shape.window) {
      this.refusedConversation.push(options)
      yield * this.refuse(input, maxTokens)
      return
    }
    const seen = currentTurn(options.messages)
    if (seen > this.lastTurn) {
      this.lastTurn = seen
      this.readsDone = 0
    }
    const turn = this.lastTurn
    if (this.readsDone < this.readsInTurn(turn)) {
      this.readsDone += 1
      const reads = this.readsDone
      const id = ToolCallId(`read-${this.conversationRequests}`)
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'considering '.repeat(Math.ceil(this.shape.think / 2)) } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'read_file', arguments: JSON.stringify({ index: reads }) } }
      yield { type: 'usage', usage: { inputTokens: input, outputTokens: this.shape.think + 20, reasoningTokens: this.shape.think } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const needed = this.answerTokens(turn)
    const continued = continuationsSoFar(options.messages)
    // A continuation writes the rest of the answer; each continuation covers what one cap allowed.
    const remaining = Math.max(60, needed - continued * Math.max(1, maxTokens - this.shape.think))
    const text = `Result for task ${turn}: ${'finding '.repeat(Math.ceil(remaining * 0.75))}`
    if (remaining + this.shape.think > maxTokens) this.cutAnswers += 1
    yield * this.answer(input, text, remaining, maxTokens, this.shape.think)
  }
}

/** The task number named by the latest human task message. */
function currentTurn(messages: readonly RequestMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const match = /^task (\d+):/u.exec(block.text)
      if (match !== null) return Number(match[1])
    }
  }
  return 0
}

/** Continuation prompts since the latest human task message. */
function continuationsSoFar(messages: readonly RequestMessage[]): number {
  let count = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === 'user' && message.content.some(block => block.type === 'text' && /^task \d+:/u.test(block.text))) break
    if (message.role === 'user' && message.source?.kind === AutoContinue.CONTINUATION_SOURCE.kind) count += 1
  }
  return count
}

export async function runSession(
  name: string,
  shape: RouteShape,
  turns: number,
  seed: number,
): Promise<RunReport> {
  const random = prng(seed)
  const report: RunReport = {
    turns,
    failedTurns: [],
    conversationRequests: 0,
    summaryRequests: 0,
    refusedConversation: 0,
    refusedSummary: 0,
    cutSummaries: 0,
    cutAnswers: 0,
    continuations: 0,
    checkpoints: 0,
    shrunkCaps: [],
    maxSurfaceTokens: 0,
    events: 0,
    msPerTurnFirstQuarter: 0,
    msPerTurnLastQuarter: 0,
    msPerTurnByQuarter: [],
    heapMb: 0,
    faults: {},
  }
  const readSizes: number[] = []
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const provider = new StressProvider(
    ctx,
    shape,
    seed + 1,
    turn => 1 + Math.floor(prng(seed + turn)() * 4),
    turn => (turn % 7 === 0 ? Math.round(shape.cap * 1.5) : 120 + Math.floor(prng(seed + 1000 + turn)() * 400)),
  )
  ctx.llm.registerAdapter(['mock'], provider)
  ctx.tools.register(defineContentToolFixture({
    name: 'read_file',
    description: 'reads a file',
    parameters: {},
    async execute(): Promise<ContentBlock[]> {
      // Sizes from a few hundred words to about two thirds of the window.
      const words = 100 + Math.floor(random() * Math.min(9000, Math.floor(shape.window * 0.6 / 1.3)))
      readSizes.push(words)
      return [{ type: 'text', text: `${'line of file content with words '.repeat(Math.ceil(words / 6))}end ${readSizes.length}` }]
    },
  }))
  ctx.logger.warn = ((message: string) => {
    const shrunk = /request output cap shrunk from \d+ to (\d+)/u.exec(message)
    if (shrunk !== null) report.shrunkCaps.push(Number(shrunk[1]))
  }) as typeof ctx.logger.warn
  await ctx.plugin(ToolResultPruner, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  // The shipped bundle's compaction settings: the default 65,536-token
  // headroom would leave the 16K and 32K routes no pressure budget.
  await ctx.plugin(BasicCompactionEngine, { maxOverflowRetries: 3, headroomTokens: 4096, maxTokens: 8192 })
  await ctx.plugin(AutoContinue, { maxContinuationsPerTurn: 8 })
  await ctx.plugin(LlmRetry)
  try {
    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId(`long-${name}`),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const durations: number[] = []
    for (let turn = 1; turn <= turns; turn += 1) {
      const started = performance.now()
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: `task ${turn}: look at the files and report ${'in detail '.repeat(turn % 5)}` }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      durations.push(performance.now() - started)
      const events = agent.session.snapshotEvents()
      const end = events.findLast(event => event.type === 'turn/end')
      const reason = end?.type === 'turn/end' ? end.data.reason : undefined
      if (reason === undefined || (reason.kind !== 'completed' && reason.kind !== 'max-tokens')) {
        report.failedTurns.push({ turn, reason: JSON.stringify(reason) })
      }
      // The turn must end with an answer the reader can see, not reasoning alone.
      const answer = events.findLast(event => event.type === 'assistant/message')
      const visible = answer?.type === 'assistant/message'
        ? answer.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()
        : ''
      if (!visible.startsWith(`Result for task ${turn}`)) {
        report.failedTurns.push({ turn, reason: `no visible answer: ${JSON.stringify(visible.slice(0, 40))}` })
      }
      report.maxSurfaceTokens = Math.max(report.maxSurfaceTokens, ctx.tokenMeter.measure(agent.session).totalTokens)
    }
    const events = agent.session.snapshotEvents()
    report.events = events.length
    report.checkpoints = events.filter(event => event.type === 'compaction/summary').length
    const attempts = events.filter(event => event.type === 'compaction/start').length
    const failures = new Map<string, number>()
    for (const event of events) {
      if (event.type !== 'compaction/end') continue
      if (event.data.error === undefined) continue
      const key = event.data.error.slice(0, 100)
      failures.set(key, (failures.get(key) ?? 0) + 1)
    }
    for (const failed of report.failedTurns) {
      const start = events.findIndex(event => event.type === 'turn/start' && event.data.turn === failed.turn)
      const trail = events.slice(Math.max(0, start - 12), Math.max(0, start - 12) + 80)
        .map(event => `${event.seq}:${event.type}${event.type === 'compaction/end' ? `(${event.data.error ?? 'ok'})` : ''}${event.type === 'turn/end' ? `(${event.data.reason.kind})` : ''}${event.type === 'compaction/summary' ? `(cap ${event.data.maxTokens}, shadow ${event.data.shadowedTokenCount})` : ''}`)
      reportLine(`TRAIL ${name} turn ${failed.turn}: ${trail.join(' ')}`)
    }
    reportLine(`COMPACTIONS ${name} attempts=${attempts} landed=${report.checkpoints} failures=${JSON.stringify([...failures])}`)
    report.continuations = events.filter(event => event.type === 'user/message'
      && event.data.source.kind === AutoContinue.CONTINUATION_SOURCE.kind).length
    const pluginMessages = new Map<string, number>()
    for (const event of events) {
      if (event.type !== 'user/message' || event.data.source.kind === 'user') continue
      const key = `${event.data.source.kind}:${event.data.content.map(block => (block.type === 'text' ? block.text.slice(0, 60) : block.type)).join('')}`
      pluginMessages.set(key, (pluginMessages.get(key) ?? 0) + 1)
    }
    reportLine(`PLUGIN-MESSAGES ${name} ${JSON.stringify([...pluginMessages])}`)
    const ends = events.filter(event => event.type === 'turn/end').map(event => (event.type === 'turn/end' ? event.data.reason.kind : ''))
    reportLine(`TURN-ENDS ${name} ${JSON.stringify(ends)}`)
    const quarter = Math.max(1, Math.floor(turns / 4))
    const average = (values: number[]): number => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    report.msPerTurnFirstQuarter = average(durations.slice(0, quarter))
    report.msPerTurnLastQuarter = average(durations.slice(-quarter))
    report.msPerTurnByQuarter = [0, 1, 2, 3].map(index => average(durations.slice(index * quarter, (index + 1) * quarter)))
    report.heapMb = Math.round(process.memoryUsage().heapUsed / 1_048_576)
  } finally {
    await ctx.fiber.dispose()
  }
  report.conversationRequests = provider.conversationRequests
  report.summaryRequests = provider.summaryRequests
  report.refusedConversation = provider.refusedConversation.length
  report.refusedSummary = provider.refusedSummary.length
  report.cutSummaries = provider.cutSummaries
  report.cutAnswers = provider.cutAnswers
  report.faults = Object.fromEntries(provider.faults)
  return report
}

export const ROUTES: Record<string, RouteShape> = {
  'small-thinking-16k': { window: 16_000, configuredWindow: 16_000, cap: 4_000, think: 600, density: [1.0, 1.5], checkpoint: 500 },
  'mid-32k': { window: 32_000, configuredWindow: 32_000, cap: 8_000, think: 1_500, density: [1.0, 1.4], checkpoint: 800 },
  'large-128k': { window: 128_000, configuredWindow: 128_000, cap: 16_000, think: 2_000, density: [1.0, 1.6], checkpoint: 1_200 },
  'coder-200k-over-configured': { window: 200_000, configuredWindow: 262_144, cap: 32_000, think: 3_000, density: [1.0, 1.3], checkpoint: 1_500 },
  'wrong-length-128k-over-32k': { window: 32_000, configuredWindow: 128_000, cap: 8_000, think: 1_000, density: [1.0, 1.0], checkpoint: 800 },
  'faulty-provider-32k': {
    window: 32_000,
    configuredWindow: 32_000,
    cap: 8_000,
    think: 1_000,
    density: [1.0, 1.2],
    checkpoint: 800,
    // Bursts of three server errors every forty requests, one outage of
    // eight in a row, a mid-stream disconnect every sixty requests, an
    // empty answer every ninety.
    faults: (request) => {
      if (request >= 150 && request < 158) return 'server'
      if (request % 40 < 3 && request > 3) return request % 80 < 3 ? 'server' : 'rate-limit'
      if (request % 60 === 0) return 'disconnect'
      if (request % 90 === 0) return 'empty'
      return undefined
    },
  },
}
