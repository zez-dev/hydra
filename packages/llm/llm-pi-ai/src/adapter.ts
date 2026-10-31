/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles, the
 * `Provider` each route built, and the `Models` collection those providers are
 * registered in — and an operation captures a whole snapshot before its first
 * `await`. Provider and model reads answer from the profiles' providers; the
 * collection exists for requests and is created by the first request that
 * streams under its snapshot, so a host without pi-ai's runtime (the browser
 * Worker deployment) still activates the routes and reads their models while
 * its requests fail. A configuration change builds a *new* collection rather
 * than mutating the one in use, because `Models.streamSimple()` is lazy: it
 * resolves the provider when the stream is first consumed, which is after the
 * credential await, so a mutated collection would let a request that started
 * under one configuration finish under another — or fail with a provider that
 * no longer exists. This is what makes the seam's per-step call freeze
 * (`llm.prepareCall()`) hold all the way down: switching models mid-reply takes
 * effect on the next step, never inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { requestImageTarget, toPiContext } from './context.ts'
import { conversationUpdates, createModels, getSupportedThinkingLevels } from './models.ts'
import { toStreamChunks } from './stream.ts'

/**
 * Initially active declaration added to an Anthropic request whose projected
 * tools are all deferred, because Anthropic rejects a tool list without one.
 */
const ANTHROPIC_TOOL_UPDATE_PLACEHOLDER: ToolSchema = {
  name: 'DeferredToolPlaceholder',
  description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.',
  parameters: { type: 'object', properties: {} },
}

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this snapshot was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * The collection holding the providers of exactly those profiles, created on the first call and returned by every
   * later one; never mutated once created. Only request paths call it.
   */
  models: () => Models
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call, and by `listModels`, which offers no
   * models while it throws `MISSING_CREDENTIAL`. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the providers those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  /** Prompt tokens per second measured per `provider/model` from completed streams: the first-byte budget's rate. */
  private readonly promptRates = new Map<string, number>()
  /** Routes whose server refused the reasoning fields this adapter adds; they are not sent there again in this process. */
  private readonly reasoningFieldsRefused = new Set<string>()
  /** Routes whose server refused a level above `high`; such a level is sent there as `high` for the rest of the process. */
  private readonly levelsAboveHighRefused = new Set<string>()

  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef) {
    const snapshot = this.current()
    this.modelOf(snapshot, provider, model)
    const profile = this.profileOf(snapshot, provider)
    return requestImageTarget(image, { maxPixels: profile.requestImagePixelBudget, maxBytes: profile.requestImageMaxBytes })
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new snapshot, and with it a brand-new collection, leaving any snapshot
   * an operation already captured untouched for as long as that operation holds
   * it. The collection is built on its first request: pi-ai's collection
   * factory needs the platform's runtime, which reads do not.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    let created: MutableModels | undefined
    const models = (): Models => {
      if (created !== undefined) return created
      const collection = createModels(this.config.auth)
      for (const profile of profiles.values()) {
        if (profile.piProvider !== undefined) collection.setProvider(profile.piProvider)
      }
      created = collection
      return collection
    }
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = profile.piProvider?.getModels().find(candidate => candidate.id === model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(async () => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      try { await this.config.resolveApiKey(provider, profile) }
      catch (error) {
        // A route whose named key does not resolve cannot serve a request, so it offers no models until the key is stored.
        if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return []
        throw error
      }
      return (profile.piProvider?.getModels() ?? []).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
      ...conversationUpdates(resolvedModel),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot),
    })
  }

  /**
   * Remember how fast a route processed a prompt: its reported input tokens
   * over the time to its first chunk, averaged with the previous measurement.
   * @param routeKey - `provider/model`.
   * @param startedAt - when the request started.
   * @param firstChunkAt - when the first chunk arrived, if one did.
   * @param inputTokens - the input tokens the provider reported, if it did.
   */
  private learnPromptRate(routeKey: string, startedAt: number, firstChunkAt: number | undefined, inputTokens: number | undefined): void {
    if (firstChunkAt === undefined || inputTokens === undefined || inputTokens <= 0) return
    const seconds = Math.max(0.001, (firstChunkAt - startedAt) / 1000)
    const rate = inputTokens / seconds
    const previous = this.promptRates.get(routeKey)
    this.promptRates.set(routeKey, previous === undefined ? rate : (previous + rate) / 2)
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const updates = conversationUpdates(model)
    // pi-ai collapses Anthropic tool updates without an initially active declaration.
    const tools = options.tools ?? []
    const needsPlaceholder = model.api === 'anthropic-messages' && updates.toolUpdate === 'in-history'
      && tools.every(tool => tool.deferLoading === true)
      && options.messages.some(message => message.role === 'developer'
        && message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal'))
    const request = needsPlaceholder
      ? { ...options, tools: [ANTHROPIC_TOOL_UPDATE_PLACEHOLDER, ...tools] }
      : options
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const routeKey = `${options.provider}/${options.model}`
    // A model with automatic reasoning levels reaches pi-ai as a non-reasoning
    // one, so pi-ai adds no reasoning field of its own; a chosen level is
    // added below, and no chosen level adds nothing, leaving the server's default.
    const auto = profile.autoReasoningModels.has(model.id)
    const piModel = auto ? { ...model, reasoning: false } : model
    let injected = auto && reasoning !== undefined && !this.reasoningFieldsRefused.has(routeKey) ? reasoning : undefined
    if (injected !== undefined && isAboveHigh(injected) && this.levelsAboveHighRefused.has(routeKey)) injected = 'high'
    const apiKey = await this.config.resolveApiKey(options.provider, profile)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    // A server is silent while it processes the prompt, so the first byte
    // gets its own budget from the prompt's size and the route's pace: the
    // rate a completed stream on this route measured, else the configured
    // floor. Later gaps are held to the idle interval.
    const promptTokens = estimatePromptTokens(options)
    const promptRate = this.promptRates.get(routeKey) ?? profile.minPromptTokensPerSecond
    const firstByteBudgetMs = Math.ceil((promptTokens / promptRate) * 2 * 1000)
    const firstByteTimeoutMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(streamIdleTimeoutMs, firstByteBudgetMs))
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT', firstByteTimeoutMs)
    const startedAt = Date.now()
    let firstChunkAt: number | undefined
    let inputTokens: number | undefined

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(request, undefined, onReplayDegrade, updates.systemPromptUpdate === 'in-history')
        : await toPiContext({ ...request, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade, updates.systemPromptUpdate === 'in-history')
      const open = (level: ModelThinkingLevel | undefined): AsyncGenerator<StreamChunk> => toStreamChunks(
        snapshot.models().streamSimple(piModel, context, {
          ...profileOptions(profile, auto ? undefined : reasoning, apiKey),
          ...options.temperature === undefined ? {} : { temperature: options.temperature },
          ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
          ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
          signal: watchdog.signal,
          // Profile headers are deployment-owned; attribution names are
          // Harness-owned and therefore win collisions.
          headers: requestHeaders(profile.headers),
          ...level === undefined ? {} : { onPayload: (payload: unknown) => withReasoningFields(payload, level) },
        }),
        model.contextWindow,
        options.signal,
        model.id,
      )[Symbol.asyncIterator]()
      let iterator = open(injected)
      /** Usage chunks held while a refusal of the added fields may still follow. */
      const held: Extract<StreamChunk, { type: 'usage' }>[] = []
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          if (result.done) {
            /* v8 ignore next 4 -- pi-ai closes every stream with a finish, so a usage chunk is never held at its end. */
            for (const chunk of held.splice(0)) {
              inputTokens = chunk.usage.inputTokens
              yield chunk
            }
            exhausted = true
            this.learnPromptRate(routeKey, startedAt, firstChunkAt, inputTokens)
            return
          }
          // A server that refuses the added reasoning fields answers with an
          // error before any content (after a usage chunk, which is held back
          // meanwhile): remember the route and reopen the same request without
          // them. A refused level above `high` is first retried as `high`, since
          // a server that validates the level names it in the same refusal.
          if (injected !== undefined) {
            if (result.value.type === 'usage') {
              held.push(result.value)
              continue
            }
            if (refusesReasoningFields(result.value)) {
              if (isAboveHigh(injected)) {
                this.levelsAboveHighRefused.add(routeKey)
                injected = 'high'
              } else {
                this.reasoningFieldsRefused.add(routeKey)
                injected = undefined
              }
              held.length = 0
              try {
                await iterator.return(undefined)
              } catch (_refusedStreamTeardown) {
                // The refused stream already ended; its teardown cannot change the retry.
              }
              iterator = open(injected)
              // The reopened request is prepared from scratch, so its first byte gets the prompt's budget again.
              watchdog.restart()
              continue
            }
            injected = undefined
            for (const chunk of held.splice(0)) {
              firstChunkAt ??= Date.now()
              inputTokens = chunk.usage.inputTokens
              yield chunk
            }
          }
          firstChunkAt ??= Date.now()
          if (result.value.type === 'usage') inputTokens = result.value.usage.inputTokens
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          // A demand the deadline abandoned can stay pending forever, and this
          // generator queues its return behind it; the abort above owns SDK termination.
          /* v8 ignore next -- the detached drain only rejects while unwinding an abandoned stream. */
          void iterator.return(undefined).catch(() => {})
        }
      }
    } catch (error: unknown) {
      const expired = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
      if (expired !== undefined) {
        const message = firstChunkAt === undefined
          ? `pi-ai first byte timeout after ${expired.timeoutMs}ms for a prompt of about ${promptTokens} tokens`
          : `pi-ai stream idle timeout after ${expired.timeoutMs}ms`
        throw new LlmError(message, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}

/**
 * Add a chosen reasoning level to an OpenAI-compatible request body in the
 * spellings the common servers read: `chat_template_kwargs` for templates
 * that switch thinking (`enable_thinking`, `thinking`) or take an effort
 * (`reasoning_effort`), and the top-level `reasoning_effort`. `off` disables
 * thinking where the template allows and asks for the lowest effort where it
 * cannot.
 * @param payload - the body pi-ai built.
 * @param level - the chosen level.
 * @returns the body with the fields added.
 */
function withReasoningFields(payload: unknown, level: ModelThinkingLevel): unknown {
  // pi-ai hands the chat-completions body it built, an object, and adds no
  // `chat_template_kwargs` of its own to a model it was told does not reason.
  const body = payload as Record<string, unknown>
  const enabled = level !== 'off'
  const effort = enabled ? level : 'low'
  return {
    ...body,
    reasoning_effort: effort,
    chat_template_kwargs: { enable_thinking: enabled, thinking: enabled, reasoning_effort: effort },
  }
}

/**
 * Whether a level is one of the two above `high`, which older servers refuse.
 * @param level - the level about to be sent.
 * @returns `true` for `xhigh` and `max`.
 */
function isAboveHigh(level: ModelThinkingLevel): boolean {
  return level === 'xhigh' || level === 'max'
}

/** Server wordings that name the added reasoning fields or reject unknown request fields. */
const REASONING_FIELD_REFUSAL = new RegExp([
  'chat_template_kwargs', 'reasoning_effort', 'enable_thinking',
  'unrecognized request argument', 'extra inputs are not permitted', 'unknown (?:field|parameter)',
].join('|'), 'iu')

/**
 * Whether a first chunk is the server refusing the added reasoning fields.
 * @param chunk - the stream's first chunk.
 * @returns `true` for an error finish whose message names them.
 */
function refusesReasoningFields(chunk: StreamChunk): boolean {
  return chunk.type === 'finish' && chunk.reason.kind === 'error' && REASONING_FIELD_REFUSAL.test(chunk.reason.failure.message)
}

/**
 * A rough size of the request's prompt, in tokens, for the first-byte budget:
 * four characters per token over the messages, the system prompt, and the
 * tool schemas.
 * @param options - the request.
 * @returns the estimated prompt tokens, at least one.
 */
function estimatePromptTokens(options: GenerateOptions): number {
  const chars = JSON.stringify(options.messages).length
    + (options.system?.length ?? 0)
    + (options.tools === undefined ? 0 : JSON.stringify(options.tools).length)
  return Math.max(1, Math.ceil(chars / 4))
}
