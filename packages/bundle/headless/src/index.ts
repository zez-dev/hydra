/**
 * @deepseek-ai/dsh-headless — one-shot direct Agent driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates one Agent through the core registry (or adopts the exact Session a
 * `--session-id` names), drives the task to quiescence, streams provider
 * reasoning to stderr, flushes its Session, prints the final assistant text to
 * stdout, and exits. With `--json` it projects the run as newline-delimited
 * events instead of the final text.
 *
 * @module @deepseek-ai/dsh-headless
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { APPROVAL_POLICIES, setApprovalPolicy, type ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionLogOffset, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
// Empty type imports carry the loader Context merge for the settlement await,
// the cmdline Context merge for the appExit host value, and the sessionQuery
// Context merge for exact Session adoption.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
// Optional service peers stay type-only so profiles can omit their packages.
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-learning'
// Declares the auto-continue message source the summary recognizes.
import type {} from '@deepseek-ai/dsh-auto-continue'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from './startup.ts'
import { internals } from './runner-internals.ts'
import { projectJsonRun, boundJsonLine } from './json-stream.ts'

/** Stable Cordis plugin name. */
export const name = 'headless-runner'

/** Core services required before the one-shot turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the task and run options resolved from this app's injected provider service. */
export interface Config {
  /** The prompt text for the single run; absent when the task arrives on stdin. */
  task?: string
  /** Exact Session identity to adopt; absent for a fresh random identity. An id with no stored Session fails. */
  sessionId?: string
  /** Whether stdout carries the machine-readable event stream instead of final text. */
  json?: boolean
  /** Permission preset applied before the task; an explicit CLI flag takes precedence. Omission keeps current policy. */
  permissionMode?: string
  /** Approval behavior applied after preset selection; an explicit CLI flag takes precedence. Omission keeps current policy. */
  approvalPolicy?: ApprovalPolicy
}

export const Config: z<Config> = z.object({
  task: z.string(),
  sessionId: z.string(),
  json: z.boolean(),
  permissionMode: z.string(),
  approvalPolicy: z.union([...APPROVAL_POLICIES]),
})

/** Why a turn ended, as its `turn/end` records it. */
type TurnReason = SessionEvent<'turn/end'>['data']['reason']

/** Message source auto-continue gives the request that continues an answer cut at the output limit. */
const CONTINUATION_KIND = 'plugin:dsh-auto-continue'

/** Message source of the runtime's notice that a background subagent finished. */
const SETTLEMENT_KIND = 'subagent-settled'

/**
 * Whether `message` is a settlement notice that says only how the child ended.
 * The subagent runtime puts the child's closing text, structured result, or
 * diagnostic after a summary line and one note, so a two-block notice has none;
 * `createSettlementMessage` in `dsh-subagent`'s `continuation-messages.ts` owns that layout.
 * @param message - one input the parent claimed.
 * @returns `true` for a notice that brings the parent no result.
 */
function bareSettlement(message: UserMessage): boolean {
  return message.source.kind === SETTLEMENT_KIND && message.content.length === 2
}

/** Outcome of one owned run interval. */
interface RunOutcome {
  text: string
  reason: TurnReason | undefined
  /**
   * Whether every answer of the final turn that stopped at the output limit
   * was continued, and the last answer finished normally. The turn still
   * records `max-tokens`, which stays sticky once any step hit the limit.
   */
  continuedPastCut: boolean
}

/**
 * Whether the run's final turn delivered its answer.
 * @param outcome - the summarized run interval.
 * @returns true for a completed turn, or a cut answer continued to a normal finish.
 */
function succeeded(outcome: RunOutcome): boolean {
  return outcome.reason?.kind === 'completed' || (outcome.reason?.kind === 'max-tokens' && outcome.continuedPastCut)
}

/**
 * The stderr line naming why a turn did not complete.
 * @param reason - the final turn's recorded end reason.
 * @returns one newline-terminated diagnostic line.
 */
function endNotice(reason: TurnReason): string {
  switch (reason.kind) {
    case 'error': return `dsh: ${reason.error.code}: ${reason.error.message}\n`
    case 'aborted': return `dsh: aborted: ${cancelText(reason.reason)}\n`
    case 'max-tokens': return 'dsh: max-tokens: the answer stopped at the output limit\n'
    // Other kinds, including ones plugins add to the merge-extensible map, are named as recorded.
    default: return `dsh: turn ended: ${reason.kind}\n`
  }
}

/**
 * Describe who or what cancelled a turn.
 * @param cause - the recorded cancellation cause.
 * @returns a short phrase for the stderr diagnostic.
 */
function cancelText(cause: Extract<TurnReason, { kind: 'aborted' }>['reason']): string {
  switch (cause.kind) {
    case 'user': return 'cancelled by the user'
    case 'parent': return 'cancelled by the parent agent'
    case 'hook': return cause.reason
    case 'disposed': return 'the agent was disposed'
    case 'legacy': return 'cancelled'
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(cause)
  }
}

/**
 * Disarm the session's goal when the round driver would continue it, so the
 * process exits without starting a round it cannot finish. The goal stays
 * active in the log; a long-lived host can resume it.
 * @param ctx - plugin context; the goals service is optional.
 * @param agent - the run's agent.
 * @returns the disarmed goal's objective, or `undefined` when no armed active goal exists.
 */
function holdArmedGoal(ctx: Context, agent: Agent): string | undefined {
  const goals = ctx.get('goals')
  const goal = goals?.get(agent)
  if (goals === undefined || goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return undefined
  goals.disarm(agent)
  return goal.objective
}

/**
 * The command name a slash-command task invokes.
 * @param task - a task the commands service resolved.
 * @returns the name between the leading `/` and the first whitespace.
 */
function commandName(task: string): string {
  /* v8 ignore next -- a split always yields a first element. */
  return task.trim().slice(1).split(/\s/u, 1)[0] ?? ''
}

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface HeadlessIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/**
 * Aggregate the interval's last assistant text; only its final turn can establish completion.
 * An answer auto-continue continued is joined with its continuations, and an answer to
 * settlement notices that bring no result follows the answer before it instead of
 * replacing it: such a notice only confirms work the parent may already have reported.
 */
function summarize(session: Session, firstSeq: SessionLogOffset): RunOutcome {
  let started = false
  let text = ''
  let reason: TurnReason | undefined
  // A continuation request makes the next answer extend the cut one instead of replacing it.
  let continuing = false
  let uncontinuedCut = false
  let lastFinish: string | undefined
  // The input an answer responds to: notices without a result, and anything else.
  let notices = false
  let otherInput = false
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`headless summary cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
    if (event.type === 'turn/start') {
      started = true
      reason = undefined
      continuing = false
      uncontinuedCut = false
      lastFinish = undefined
      notices = false
      otherInput = false
      continue
    }
    if (!started) continue
    if (event.type === 'user/message' && event.data.source.kind === CONTINUATION_KIND) {
      continuing = true
      uncontinuedCut = false
    }
    if (event.type === 'user/message') {
      if (bareSettlement(event.data)) notices = true
      else otherInput = true
    }
    if (event.type === 'tool/result') otherInput = true
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') {
        text = continuing ? text + joined : notices && !otherInput && text !== '' ? `${text}\n\n${joined}` : joined
      }
      continuing = false
      notices = false
      otherInput = false
      const finish = expandAssistantStream(event.data.stream)
        .map(entry => entry.chunk)
        .find(chunk => chunk.type === 'finish')
      lastFinish = finish?.type === 'finish' ? finish.reason.kind : undefined
      if (lastFinish === 'max-tokens') uncontinuedCut = true
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason, continuedPastCut: !uncontinuedCut && lastFinish !== undefined }
}

/**
 * Project provider-reported reasoning from one owned run to stderr as it is
 * streamed, while keeping final outcome derivation on the durable log.
 * @param ctx - plugin context carrying the live Assistant frame feed.
 * @param agent - the exact Agent whose reasoning belongs to this invocation.
 * @param stderr - progress output sink.
 * @returns a disposer that also terminates an unterminated reasoning line.
 */
function streamReasoning(
  ctx: Context,
  agent: Agent,
  stderr: HeadlessIo['stderr'],
): () => void {
  let open = false
  let endsWithNewline = true
  const close = (): void => {
    if (!open) return
    if (!endsWithNewline) stderr.write('\n')
    open = false
    endsWithNewline = true
  }
  const dispose = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    if (frame.type === 'start') {
      close()
      return
    }
    if (frame.type === 'end') {
      close()
      return
    }
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'reasoning-delta':
        if (chunk.text === '') return
        if (!open) {
          stderr.write('dsh: reasoning:\n')
          open = true
        }
        stderr.write(chunk.text)
        endsWithNewline = chunk.text.endsWith('\n')
        return
      case 'block-start':
        if (chunk.blockType !== 'reasoning') close()
        return
      case 'block-end':
        if (chunk.block.type !== 'reasoning') close()
        return
      case 'usage':
        return
      case 'text-delta':
      case 'tool-call-delta':
      case 'finish':
        close()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(chunk, 'headless reasoning stream')
    }
  })
  return () => {
    dispose()
    close()
  }
}

/** The Session facts that decide whether the runner may drive it directly. */
interface AdoptableHeader {
  cwd?: string | undefined
  origin?: 'subagent' | undefined
  agentPreset?: string | undefined
}

/** Iterate a live Session's durable events in order. */
function* liveEvents(session: Session): Generator<SessionEvent> {
  const length = session.seq
  for (let seq = 0; seq < length; seq++) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`headless adoption cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
    yield event
  }
}

/**
 * The preset a Session currently runs under: its creation header advanced by
 * the last `agent-preset/selected` event. The header is only a creation fact;
 * the presets plugin reconstructs a session's composition from the projection.
 */
function currentPreset(header: AdoptableHeader, events: Iterable<SessionEvent>, sessionId: SessionId): string | undefined {
  let preset = header.agentPreset
  for (const event of events) {
    // Owned by dsh-agent-preset-registry, which this bundle does not compose, so the
    // event is read structurally rather than through its module augmentation.
    const candidate = event as unknown as { type: string; data?: { agentPreset?: unknown } }
    if (candidate.type !== 'agent-preset/selected') continue
    const selected = candidate.data?.agentPreset
    // A corrupt record must not read as "no preset": that would let the run
    // continue under this bundle's composition instead of the recorded one.
    if (typeof selected !== 'string' || selected === '') {
      throw new Error(`session "${sessionId}" records a malformed agent-preset/selected event and cannot be adopted`)
    }
    preset = selected
  }
  return preset
}

/** Reject a Session the one-shot runner must not adopt. */
function assertAdoptable(header: AdoptableHeader, events: Iterable<SessionEvent>, sessionId: SessionId, cwd: string): void {
  const preset = currentPreset(header, events, sessionId)
  if (preset !== undefined) {
    // This bundle composes no preset roster, so resuming the session here would
    // silently run it under the headless tools and prompts instead of the
    // composition its log records.
    throw new Error(
      `session "${sessionId}" runs under agent preset "${preset}", which the one-shot runner does not compose`,
    )
  }
  if (header.origin === 'subagent') {
    throw new Error(`session "${sessionId}" is a subagent session and cannot be driven directly`)
  }
  if (header.cwd === undefined) {
    throw new Error(`session "${sessionId}" recorded no working directory, so it cannot be adopted`)
  }
  if (header.cwd !== cwd) {
    throw new Error(`session "${sessionId}" was recorded in "${header.cwd}", not "${cwd}"`)
  }
}

/**
 * Resolve the Agent for one run: adopt the persisted Session with the requested
 * id. The identity must already exist, and no Agent may be live under it; a
 * first round omits the option instead, so a typo cannot pass as a brand-new
 * conversation.
 * @param ctx - plugin context carrying the Session query service.
 * @param agents - the core Agent registry.
 * @param sessionId - exact Session identity to adopt.
 * @param agentOptions - provider/model pair for this run.
 * @param setup - per-Agent scope setup installing the model selection.
 * @param cwd - working directory resolved in the mounted filesystem.
 * @returns the resumed Agent.
 */
async function resolveAgent(
  ctx: Context,
  agents: Context['agents'],
  sessionId: SessionId,
  agentOptions: AgentOptions,
  setup: (agentCtx: Context, agent: Agent) => void | Promise<void>,
  cwd: string,
): Promise<Agent> {
  // Resuming promises the caller a log a later process can continue. Without a
  // durable log the run would succeed, print the id, and still lose the whole
  // history at exit, so a miscomposed profile fails loud before the resume.
  if (ctx.get('sessionPersistence') === undefined) {
    throw new Error('headless --session-id requires the sessionPersistence service; the Session would not survive this process')
  }
  // A later process holds no live Agent and has to find the id through the
  // query service, so every --session-id run requires it.
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new Error('headless --session-id requires the sessionQuery service; dsh-base provides it')
  }
  const live = agents.get(sessionId)
  if (live !== undefined) {
    // A live Agent already has an owner that may still drive it, and `whenIdle`
    // is not a single-message signal: folding its next interval into this run
    // would mix that owner's events — even its final answer — into the stream.
    // The runner cannot claim an exclusive interval over an Agent it did not
    // create, so it refuses the identity; the adoptability rules run first so a
    // real mismatch is named instead of the generic refusal.
    assertAdoptable(live.session.header, liveEvents(live.session), sessionId, cwd)
    throw new Error(`session "${sessionId}" is live in this process, so the one-shot runner cannot own an exclusive run interval`)
  }
  try {
    using observation = await query.observeSession(sessionId)
    assertAdoptable(observation.header, observation.events, sessionId, cwd)
    const { agent } = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    // The observation is a snapshot: another writer may have appended a preset
    // selection before this process took the write lease. Re-check the log
    // resume actually attached, now that no other process can append.
    assertAdoptable(agent.session.header, liveEvents(agent.session), sessionId, cwd)
    return agent
  } catch (error: unknown) {
    if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
    // --session-id resumes a conversation that already exists; starting a new
    // one is the no-id path, which generates its own identity and reports it in
    // the `session` event. Creating the requested id here would turn a typo
    // into a brand-new empty history the caller believes it is continuing.
    throw new Error(`session "${sessionId}" does not exist; omit --session-id to start a new Session`)
  }
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: HeadlessIo, error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error)
  if (json) io.stdout.write(`${boundJsonLine({ type: 'error', message })}\n`)
  io.stderr.write(`dsh: ${message}\n`)
  io.exit(1)
}

/**
 * Run one task through one Agent and request process exit.
 * Live Agent failures require a later durable terminal before a recovered run can succeed.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - task, exact Session identity, output mode, permission preset, and approval policy.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: HeadlessIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  // A Cordis overlay sets the row directly and bypasses the CLI trim check, so
  // the same public setting must fail here rather than become a blank identity.
  if (config.sessionId !== undefined && config.sessionId.trim() === '') {
    throw new Error('headless-runner: sessionId must not be blank')
  }

  const startup = ctx.get('headlessStartup')
  const permissionMode = startup?.permissionMode ?? config.permissionMode
  const approvalPolicy = startup?.approvalPolicy ?? config.approvalPolicy
  const approval = ctx.get('approval')
  const permissions = ctx.get('permissionPresets')
  if (permissionMode !== undefined) {
    if (permissions === undefined) throw new Error('headless --permission-mode requires the permissionPresets service')
    permissions.resolve(permissionMode)
  }
  if (approvalPolicy !== undefined && approval === undefined) {
    throw new Error('headless --approval-policy requires the approval service')
  }
  const requestedRoots = startup?.additionalWritableRoots
  if (requestedRoots !== undefined && requestedRoots.length > 0) {
    const policy = ctx.get('sandboxPolicy')
    if (policy === undefined || requestedRoots.some(root => !policy.additionalWritableRoots?.includes(root))) {
      throw new Error('headless --add-dir requires the sandbox-policy row to include headlessStartup.additionalWritableRoots; check the profile overlays')
    }
  }

  const task = config.task === undefined || config.task === '-'
    ? await internals.readStdin()
    : config.task
  if (task.trim() === '') {
    throw new Error('a task is required, for example: dsh --profile headless "run the tests"')
  }

  const selection = defaultModel.currentSelection()
  const agentOptions: AgentOptions = { ...selection }
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer. A deployment
  // that DOES configure one has to join it here first
  // (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").
  const setup = (agentCtx: Context, agent: Agent): void => {
    // A resumed Session continues with this run's configured model.
    if (config.sessionId !== undefined) {
      const previous = agent.model.current()
      const configured = { ...selection }
      if (configured.reasoningEffort === undefined && previous !== undefined
        && previous.provider === configured.provider && previous.model === configured.model
        && previous.reasoningEffort !== undefined) {
        configured.reasoningEffort = previous.reasoningEffort
      }
      agent.model.select(configured)
    }
    installModelSelection(agentCtx)
  }
  const sessionId = brandString<SessionId>(config.sessionId ?? `session-${randomUUID()}`)
  const fs = ctx.get('fs')
  const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
  const agent = config.sessionId === undefined
    ? (await agents.create({
      sessionId,
      meta: { cwd },
      agentOptions,
      setup,
    })).agent
    : await resolveAgent(ctx, agents, sessionId, agentOptions, setup, cwd)
  await agent.whenIdle()
  if (config.sessionId !== undefined) {
    // The resume-time check read a snapshot; an overlay can still append a
    // preset selection between it and the interval this run now owns, so
    // re-read the log the runner holds before submitting the task.
    assertAdoptable(agent.session.header, liveEvents(agent.session), sessionId, cwd)
  }
  if (permissionMode !== undefined && permissions !== undefined) permissions.set(agent.session, permissionMode)
  if (approvalPolicy !== undefined && approval?.overrideOf(agent.session) !== approvalPolicy) {
    setApprovalPolicy(agent.session, approvalPolicy)
  }
  const firstSeq = agent.session.seq
  const projection = config.json === true ? projectJsonRun(ctx, agent, io.stdout, { cwd }) : undefined
  const stopReasoning = projection === undefined ? streamReasoning(ctx, agent, io.stderr) : undefined
  let failure: { error: unknown; atOffset: SessionLogOffset } | undefined
  const stopErrors = ctx.on('agent/error', ({ agent: subject, error }) => {
    if (subject === agent) failure = { error, atOffset: agent.session.seq }
  })
  const stopTerminals = ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'turn/end'
      && failure !== undefined && event.seq >= failure.atOffset) failure = undefined
  })
  const commandAbort = new AbortController()
  try {
    let command: CommandExecution | undefined
    let heldGoal: string | undefined
    try {
      // A task naming a registered slash command runs that command, as an
      // interactive surface would; any other text, including a path that
      // starts with `/`, is the model's task.
      command = await ctx.get('commands')?.execute(agent, task.trim(), [], commandAbort.signal)
      if (command === undefined) {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: task }],
          source: { kind: 'user' },
        }))
      }
      const subagents = ctx.get('subagents')
      while (true) {
        await agent.whenIdle()
        const idleSeq = agent.session.seq
        // Child settlement can wake the parent before the child wait observes it.
        if (!await subagents?.waitForChildren(agent)
          && agent.status === 'idle' && agent.session.seq === idleSeq) break
      }
      // Synchronous with the exit decision, so the goal driver's next
      // reservation sees the goal disarmed.
      heldGoal = holdArmedGoal(ctx, agent)
    } finally {
      stopReasoning?.()
    }
    // Process exit would cancel the last turn's learning review; it has its own
    // deadline. Background jobs nobody awaits are not waited for.
    await ctx.get('learning')?.settled(agent.session.id)
    await sessions.flush(agent.session)
    if (failure !== undefined) throw failure.error
    const outcome = summarize(agent.session, firstSeq)
    const result = command?.result
    // A command answers with its own text; a turn it started adds that turn's answer.
    const text = command === undefined
      ? outcome.text
      : [result?.kind === 'success' ? result.text : undefined, outcome.reason === undefined ? undefined : outcome.text]
        .filter(part => part !== undefined && part !== '').join('\n')
    if (projection === undefined) io.stdout.write(text + '\n')
    else projection.finish(text, outcome.reason)
    if (result?.kind === 'error') io.stderr.write(`dsh: /${commandName(task)}: ${result.text}\n`)
    else if (outcome.reason !== undefined && !succeeded(outcome)) io.stderr.write(endNotice(outcome.reason))
    if (heldGoal !== undefined) {
      io.stderr.write(`dsh: goal "${heldGoal}" is still active; this headless run answered one task, so the goal's next round did not start\n`)
    }
    const commandOnly = command !== undefined && outcome.reason === undefined
    io.exit(result?.kind === 'error' ? 1 : commandOnly || succeeded(outcome) ? 0 : 1)
  } finally {
    commandAbort.abort()
    stopErrors()
    stopTerminals()
    projection?.dispose()
  }
}

/**
 * Mount the one-shot direct driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated task and run options.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('headless-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: HeadlessIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error, config.json === true) })
}
