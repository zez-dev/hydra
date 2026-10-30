/**
 * Default one-shot summarization and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, BlockAssembler, LlmError, lowestReasoningEffort } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, ReasoningEffortId, RequestMessage, TokenUsage, ToolHistory, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Dead Ends and Settled Facts',
  '- [approach that was tried and failed, where, and why: do not retry it without new evidence]',
  '- [conclusion a test, a measurement, or the user confirmed, and its scope: do not re-investigate it]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure. Carry every dead end and settled fact forward unless the conversation since disproved it.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** The route's lowest reasoning effort the request asked for, when the route offers one. */
  reasoningEffort?: ReasoningEffortId
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused. An answer with
 * no text is asked once more: without the tools and the tool history when the
 * model called one, at the route's default effort when the lowest effort was
 * asked; a route whose default effort then answers is asked at its default
 * from then on.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 * @throws an `Error` with code {@link SUMMARY_EMPTY_CODE}, naming what the answer held, when no answer has text.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const messages: RequestMessage[] = [
    ...input.messages,
    deepFreeze({
      role: 'user',
      content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
    }),
  ]
  // A thinking model spends a summary's cap on reasoning first, and near a
  // full window the cap cannot be raised far; its lowest effort leaves the
  // cap to the summary. The effort is a preference: an unresolvable route
  // fails loud in the stream call itself.
  const routeKey = `${target.provider}/${target.model}`
  const defaultEffortRoutes = defaultEffortRoutesOf(ctx)
  const lowest = defaultEffortRoutes.has(routeKey)
    ? undefined
    : await ctx.llm.resolveModelInfo(target.provider, target.model, signal).then(info => lowestReasoningEffort(info), () => undefined)
  let attempt: { readonly tools?: ToolSchema[]; readonly toolHistory?: ToolHistory; readonly reasoningEffort?: ReasoningEffortId } = {
    toolHistory: agent.session.toolHistory(),
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    ...lowest === undefined ? {} : { reasoningEffort: lowest },
  }
  for (let retried = false; ; retried = true) {
    const options: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      messages,
      ...attempt.toolHistory === undefined ? {} : { toolHistory: attempt.toolHistory },
      ...attempt.tools === undefined ? {} : { tools: attempt.tools },
      maxTokens: config.maxTokens,
      ...attempt.reasoningEffort === undefined ? {} : { reasoningEffort: attempt.reasoningEffort },
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error

    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    if (summary.some(block => block.text.trim().length > 0)) {
      // A text answer at the default effort after an empty one at the lowest: the route keeps its default from now on.
      if (lowest !== undefined && attempt.reasoningEffort === undefined) defaultEffortRoutes.add(routeKey)
      return {
        summary,
        rawOutput,
        llmStreamCall: true,
        provider: options.provider,
        model: options.model,
        maxTokens: config.maxTokens,
        ...attempt.reasoningEffort === undefined ? {} : { reasoningEffort: attempt.reasoningEffort },
        ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
      }
    }
    // One more request drops what most likely kept the text out: the tools,
    // which ride along for the prefix cache, when the model called one; the
    // lowered effort, which some servers turn into an answer filed entirely
    // as reasoning, otherwise.
    const calledTool = rawOutput.some(block => block.type === 'tool-call')
    let next: typeof attempt | undefined
    if (calledTool && attempt.tools !== undefined) {
      const { tools: _tools, toolHistory: _toolHistory, ...kept } = attempt
      next = kept
    } else if (!calledTool && attempt.reasoningEffort !== undefined) {
      const { reasoningEffort: _effort, ...kept } = attempt
      next = kept
    }
    if (retried || next === undefined) {
      throw Object.assign(new Error(`summarization produced no text summary content: ${emptyAnswer(rawOutput)}`), { code: SUMMARY_EMPTY_CODE })
    }
    attempt = next
  }
}

/** Routes that answered a checkpoint with no text at their lowest effort and with text at their default, by plugin context. */
const defaultEffortRoutesByContext = new WeakMap<Context, Set<string>>()

function defaultEffortRoutesOf(ctx: Context): Set<string> {
  let routes = defaultEffortRoutesByContext.get(ctx)
  if (routes === undefined) {
    routes = new Set()
    defaultEffortRoutesByContext.set(ctx, routes)
  }
  return routes
}

/** Code of the error a summarization answer without text throws. */
export const SUMMARY_EMPTY_CODE = 'SUMMARY_EMPTY'

/**
 * What a summarization answer without text held instead.
 * @param blocks - the answer's blocks.
 * @returns a phrase naming the tool it called, its reasoning, or nothing.
 */
function emptyAnswer(blocks: readonly ContentBlock[]): string {
  const call = blocks.find(block => block.type === 'tool-call')
  if (call !== undefined) return `the model called ${call.name} instead`
  return blocks.some(block => block.type === 'reasoning') ? 'the reply held only reasoning' : 'the reply was empty'
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
