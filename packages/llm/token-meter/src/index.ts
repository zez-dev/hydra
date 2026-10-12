/**
 * Single replay-aware token-meter service for request and surface pressure.
 *
 * @module @deepseek-ai/dsh-token-meter
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction-image-offload/projection'
import z from '@deepseek-ai/schemastery'
import { assembleAssistantStream, usageTokens } from '@deepseek-ai/dsh-llm'
import type { LlmImageRequestPricing, LlmRuntime, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  EpochHeader,
  Session,
  SessionEvent,
  SessionLogOffset as SessionLogOffsetType,
} from '@deepseek-ai/dsh-session'
import {
  canonicalHeader,
  headerEquals,
  isSurfaceEvent,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
// Type-only: activates the `ctx.sessionProjections` Context declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  TokenMeasurement,
  TokenMeasurementBaseline,
  TokenMeterConfig,
} from './types.ts'
import { contextBreakdownProjectionDefinition } from './breakdown-projection.ts'
import { contextPressureProjectionDefinition, tokenUsageProjectionDefinition } from './usage-projection.ts'
import { estimateContent, estimateMessage, estimateToolSchemas, estimateToolsTokens, ROLE_OVERHEAD } from './estimate.ts'
import { commitSurfaceTokens, planSurfaceTokens } from './surface-fold.ts'
import type { MeterSurfaceNode } from './surface-fold.ts'
import { priceSurface } from './route-pricing.ts'

export type * from './types.ts'
// Module-edge re-export: forces the emitted index.d.ts to import the
// projection-unit modules, so their SessionProjectionStateMap augmentations load
// in aggregate programs that only import the package root.
export type * from './usage-projection.ts'
export type * from './breakdown-projection.ts'

/**
 * Raw anchor facts captured at the latest successful call; the baseline is
 * derived per measurement so the anchored surface reprices under the same
 * route pricing as the current surface it is compared with.
 */
interface MeasurementAnchor {
  readonly header: EpochHeader | undefined
  /** Priced surface immediately before the anchored assistant message commits. */
  readonly nodes: readonly MeterSurfaceNode[]
  /** Fixed-heuristic price of the call's provider output. */
  readonly assistantTokens: number
  /** Provider usage of the call, when it reported one under a known header. */
  readonly usage: TokenUsage | undefined
}

interface ReplayState {
  consumedEvents: SessionLogOffsetType
  header: EpochHeader | undefined
  surface: MeterSurfaceNode[]
  stepStart: { turn: number; step: number } | undefined
  anchor: MeasurementAnchor | undefined
  /**
   * Heuristic-priced densities (provider count over the heuristic's) of the
   * newest usage anchors on the route of the current header, newest last, so
   * a measurement prices at the densest recent request rather than the last one.
   */
  densities: number[]
  /** The last headerless measurement and the log revision it describes, reused until the log grows. */
  memo: { revision: SessionLogOffsetType; measurement: TokenMeasurement } | undefined
}

/** Usage anchors whose densities a measurement remembers. */
const DENSITY_ANCHORS = 8

/** Compare optional envelopes so a headerless estimate can track later surface deltas. */
function optionalHeaderEquals(
  left: EpochHeader | undefined,
  right: EpochHeader | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return headerEquals(promptHeader(left), promptHeader(right))
}

/**
 * The part of a request envelope that decides what its prompt costs: the
 * route and the tool schemas. The output cap, sampling scalars, and adapter
 * defaults change nothing about the prompt, so a usage anchor survives them.
 */
function promptHeader(header: EpochHeader): EpochHeader {
  return {
    config: { provider: header.config.provider, model: header.config.model },
    ...header.tools === undefined ? {} : { tools: header.tools },
  }
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateConfigKeys(config: TokenMeterConfig): void {
  for (const key of Object.keys(config)) {
    throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tokenMeter: TokenMeter
  }
}

/** Replay owner for one service-wide estimator and isolated per-session folds. */
export class TokenMeter extends Service {
  // Schemastery preserves untrusted loader keys on an empty object schema;
  // the public type excludes settings while validateConfigKeys rejects them.
  static Config: z<TokenMeterConfig> = z.object({}) as unknown as z<TokenMeterConfig>

  static inject = ['sessionProjections']

  private readonly states = new WeakMap<Session, ReplayState>()

  constructor(ctx: Context, config: TokenMeterConfig = {}) {
    super(ctx, 'tokenMeter')
    validateConfigKeys(config)

    ctx.sessionProjections.register(tokenUsageProjectionDefinition)
    ctx.sessionProjections.register(contextPressureProjectionDefinition)
    ctx.sessionProjections.register(contextBreakdownProjectionDefinition)

    // Readers catch up independently, while eager observation bounds ordinary
    // read latency without creating state for sessions no consumer has read.
    ctx.on('session/event', (session) => {
      if (this.states.has(session)) this._sync(session)
    })
  }

  /**
   * Measure current request pressure and surface through the durable tail.
   *
   * The effective envelope's routed provider/model selects the request-image
   * pricing every node is priced under: a route whose adapter declares image
   * pricing charges each retained image its visual tokens plus its
   * model-visible text, while other routes keep the fixed heuristic. Provider
   * usage is reused only when the latest successful call's route and tool
   * schemas match `requestHeader` (its output cap and sampling scalars may
   * differ) and its total is no lower than that call's full route-priced
   * anchor; otherwise the complete envelope and surface are repriced. On a
   * route without image pricing, the surface delta since a usage anchor is
   * priced at the route's density, the provider's count over the heuristic's
   * for the same request, taken as the densest of the newest usage anchors on
   * that route so one lighter request does not relax the guess. The anchor
   * includes all surface nodes immediately before the assistant message,
   * including inputs admitted after step/start.
   *
   * `requestHeader` replaces the latest logged envelope for pressure and node
   * pricing; the node set always describes the current session surface. Every
   * call at a new log revision clones those positional nodes, so measurement
   * is O(surface); a headerless call at an unchanged revision returns the same
   * frozen snapshot.
   *
   * @param session - session to replay through its current durable tail.
   * @param requestHeader - optional effective request envelope replacing the latest logged header.
   * @returns a detached deeply immutable pressure and surface measurement.
   */
  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement {
    const state = this._sync(session)
    // Several consumers measure the same revision within one step (the
    // pressure check, the cap clamp, range selection); the frozen result is
    // shared until the log grows.
    if (requestHeader === undefined && state.memo?.revision === state.consumedEvents) return state.memo.measurement
    const measurement = this._measure(state, requestHeader)
    if (requestHeader === undefined) state.memo = { revision: state.consumedEvents, measurement }
    return measurement
  }

  /** Price the synced state, optionally under a replacement request envelope. */
  private _measure(state: ReplayState, requestHeader: EpochHeader | undefined): TokenMeasurement {
    const header = requestHeader === undefined
      ? state.header
      : canonicalHeader(requestHeader)
    const pricing = this._routeImagePricing(header)
    const fileText = this._fileRequestText()
    const surface = priceSurface(state.surface, pricing, fileText)
    const anchor = state.anchor

    let baseline: TokenMeasurementBaseline
    let surfaceDeltaTokens: number
    let density = 1
    if (anchor !== undefined && optionalHeaderEquals(anchor.header, header)) {
      // Matching headers share one route, so the anchored snapshot reprices
      // under the same pricing as the current surface and the signed delta
      // compares like with like.
      const anchorSurfaceTokens = priceSurface(anchor.nodes, pricing, fileText).surfaceTokens
        + anchor.assistantTokens
      const estimatedAnchorTokens = estimateToolsTokens(header) + anchorSurfaceTokens
      const usage = anchor.usage
      // Signed heuristic deltas remain conservative only from an anchor
      // that is at least as large as the matching full heuristic price.
      baseline = usage !== undefined && usageTokens(usage) >= estimatedAnchorTokens
        ? { kind: 'usage', tokens: usageTokens(usage), usage }
        : { kind: 'estimated', tokens: estimatedAnchorTokens }
      surfaceDeltaTokens = surface.surfaceTokens - anchorSurfaceTokens
      // The provider's count for the anchored request against the heuristic's
      // price of the same request is this route's density; the surface delta
      // since is priced at that density, not at the heuristic's. A route with
      // image pricing already prices images exactly, so its delta stays as is.
      if (pricing === undefined && baseline.kind === 'usage' && estimatedAnchorTokens > 0) {
        density = Math.max(baseline.tokens / estimatedAnchorTokens, ...state.densities)
      }
    } else if (header === undefined && surface.surfaceTokens === 0) {
      baseline = { kind: 'none', tokens: 0 }
      surfaceDeltaTokens = 0
    } else {
      baseline = {
        kind: 'estimated',
        tokens: estimateToolsTokens(header) + surface.surfaceTokens,
      }
      surfaceDeltaTokens = 0
    }

    return deepFreeze(structuredClone({
      logRevision: state.consumedEvents,
      baseline,
      surfaceDeltaTokens,
      density,
      totalTokens: Math.max(0, baseline.tokens + Math.round(surfaceDeltaTokens * density)),
      estimatedTokens: estimateToolsTokens(header) + surface.surfaceTokens,
      surfaceTokens: surface.surfaceTokens,
      nodes: surface.nodes,
    }))
  }

  /** Resolve the routed model's image pricing, when the llm service and route declare one. */
  private _routeImagePricing(header: EpochHeader | undefined): LlmImageRequestPricing | undefined {
    const config = header?.config
    if (config === undefined) return undefined
    return this.ctx.get('llm')?.imageRequestPricing(config.provider, config.model)
  }

  /** Resolve request-time file projection when an LLM service is mounted. */
  private _fileRequestText(): (
    (ref: Parameters<LlmRuntime['fileRequestText']>[0]) => string
  ) | undefined {
    const llm = this.ctx.get('llm')
    return llm === undefined ? undefined : ref => llm.fileRequestText(ref)
  }

  /**
   * Heuristically price one model-visible message (instance face of the pure
   * `estimateMessage` export from `estimate.ts`).
   * @param message - message to price without mutation.
   * @returns content and role-framing tokens under the fixed service heuristic.
   */
  estimateMessage(message: Message): number {
    return estimateMessage(message)
  }

  /**
   * Heuristically price tool schemas the way a logged request header's are
   * priced (instance face of the pure `estimateToolSchemas` export).
   * @param tools - tool schemas in canonical order.
   * @returns heuristic tool-schema tokens; 0 when empty.
   */
  estimateTools(tools: readonly ToolSchema[]): number {
    return estimateToolSchemas(tools)
  }

  /** Catch one session's fold up to the current durable tail. */
  private _sync(session: Session): ReplayState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = {
        consumedEvents: SessionLogOffset(0),
        header: undefined,
        surface: [],
        stepStart: undefined,
        anchor: undefined,
        densities: [],
        memo: undefined,
      }
      this.states.set(session, state)
    }

    while (state.consumedEvents < session.seq) {
      // Contiguous session seqs index the durable log; existing Session history read, migration deferred.
      // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
      const event = session.eventAt(SessionSeq(state.consumedEvents))!
      this._foldEvent(state, event)
      state.consumedEvents = SessionLogOffset(state.consumedEvents + 1)
    }
    return state
  }

  /**
   * Run every fallible step — surface plan and anchor validation — before
   * mutating replay state, so a malformed event remains unread on every
   * retry instead of half-applying.
   */
  private _foldEvent(state: ReplayState, event: SessionEvent): void {
    let nextHeader = state.header
    let nextStepStart = state.stepStart
    let nextAnchor = state.anchor

    switch (event.type) {
      case 'image/offload': {
        const offloaded = new Map(event.data.targets.map(target => [target.seq, new Set(target.imageIndexes)]))
        state.surface = state.surface.map((node) => {
          const indexes = offloaded.get(node.seq)
          if (indexes === undefined) return node
          return {
            ...node,
            images: node.images.map((image, index) => (indexes.has(index) ? { ...image, offloaded: true as const } : image)),
          }
        })
        break
      }
      case 'request/header':
        nextHeader = canonicalHeader(event.data.header)
        break
      case 'step/start':
        if (state.stepStart !== undefined) {
          throw new Error(
            `token meter: step/start at seq ${event.seq} arrived before turn ${state.stepStart.turn}/step ${state.stepStart.step} ended`,
          )
        }
        nextStepStart = { ...event.data }
        break
      case 'step/end':
        if (state.stepStart === undefined
          || state.stepStart.turn !== event.data.turn
          || state.stepStart.step !== event.data.step) {
          throw new Error(`token meter: step/end at seq ${event.seq} has no matching step/start event`)
        }
        nextStepStart = undefined
        break
      default:
        break
    }

    const plan = isSurfaceEvent(event)
      ? planSurfaceTokens(state.surface, event)
      : undefined

    if (event.type === 'assistant/message') {
      const stepStart = state.stepStart
      if (stepStart === undefined
        || stepStart.turn !== event.data.turn
        || stepStart.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} has no matching step/start event`)
      }

      // assistant/message is surface-mandatory at every append/seed boundary.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const eventTokens = plan!.tokens
      // The loop admits prompts and user messages after step/start; retries may
      // replace them before succeeding. Only the pre-assistant surface is priced
      // by this call. Provider output stays separate from durable output rewrites.
      if (event.data.usage !== undefined && nextHeader !== undefined) {
        nextAnchor = {
          header: nextHeader,
          nodes: [...state.surface],
          assistantTokens: this._estimateProviderAssistant(event),
          usage: event.data.usage,
        }
        // The route's recent densities, in heuristic terms; a route change starts over.
        const heuristic = estimateToolsTokens(nextHeader)
          + state.surface.reduce((sum, node) => sum + node.heuristicTokens, 0)
          + nextAnchor.assistantTokens
        const counted = usageTokens(event.data.usage)
        if (state.anchor !== undefined && !optionalHeaderEquals(state.anchor.header, nextHeader)) state.densities = []
        if (heuristic > 0 && counted >= heuristic) {
          state.densities = [...state.densities.slice(-(DENSITY_ANCHORS - 1)), counted / heuristic]
        }
      } else {
        nextAnchor = {
          header: nextHeader,
          nodes: [...state.surface],
          assistantTokens: eventTokens,
          usage: undefined,
        }
      }
    }

    state.header = nextHeader
    state.stepStart = nextStepStart
    if (plan !== undefined) {
      commitSurfaceTokens(state.surface, plan)
    }
    state.anchor = nextAnchor
  }

  /**
   * Reassemble provider output from the message's exact embedded stream.
   */
  private _estimateProviderAssistant(
    event: SessionEvent<'assistant/message'>,
  ): number {
    const providerContent = assembleAssistantStream(event.data.stream).blocks()
    return providerContent.length === 0 ? 0 : estimateContent(providerContent) + ROLE_OVERHEAD
  }
}

export default TokenMeter
