# Same-session goals

English | [中文](goal.zh.md)

Types shared by the event-sourced goal service and its policy consumers. The [goal-domain Agent Note](../../.agents/notes/implemented/feature/2026-07-19-persisted-same-session-goal-domain.md) owns the persistence and activation decisions; this page records the exact fields and variants from [`packages/goal/goal/src/types.ts`](../../packages/goal/goal/src/types.ts).

## Identity and lifecycle

`GoalId` is a [branded id](core.md#branded-ids). A caller mutates one exact revision through `GoalRef`; every accepted durable mutation increments the revision.

```ts type-equiv
/** Compare-and-set identity for one exact goal revision. */
interface GoalRef {
  /** Stable goal identity. */
  readonly id: GoalId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}
```

The durable phase answers what happened to the objective. Process-local activation separately answers whether a continuation consumer may start another round.

```ts type-equiv
/** Durable continuation phase. Activation is process-local and separate. */
type GoalPhase =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'
```

Blocking is the single durable stopped-by-a-problem state. Its policy-owned reason carries a stable lower-kebab-case code for routing and a free-form explanation for humans and models.

```ts type-equiv
/** Machine-routable and human-readable explanation for a blocked goal. */
interface GoalBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}
```

```ts type-equiv
/** Full durable state written by every non-clear goal mutation. */
interface GoalSnapshot extends GoalRef {
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: GoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: GoalBlockReason
  /** Total admitted goal-round cap. */
  readonly maxGoalRounds: number
}
```

```ts type-equiv
/** Current goal projection, including values derived from the session log. */
interface GoalView extends GoalSnapshot {
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: GoalActivation
}
```

The service also publishes process-local activation edges without changing durable state; clients consume this event for live status.

```ts type-equiv
/** Live process-local activation update forwarded to UI clients. */
interface GoalActivationChanged {
  /** Session whose live goal activation changed. */
  readonly sessionId: SessionId
  /** Current exact activation, absent when no goal is current. */
  readonly goal?: {
    /** Exact current goal identity. */
    readonly id: GoalId
    /** Exact current goal revision. */
    readonly revision: number
    /** Current process-local continuation state. */
    readonly activation: GoalActivation
  }
}
```

## Durable changes

Every mutation is a durable `goal/change` session event whose payload is either a complete post-mutation snapshot or a clear tombstone. The strict fold and persisted projection derive lifecycle state only from these events; inbox mutations do not affect goal state.

```ts type-equiv
/** Full-snapshot goal mutation committed by a durable `goal/change` event. */
interface GoalSnapshotChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: Exclude<GoalOperation, 'clear'>
  readonly goal: GoalSnapshot
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
}
```

```ts type-equiv
/** Tombstone retained when the current goal is cleared. */
interface GoalClearChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: GoalRef
  readonly clearedAt: number
}
```

A continuation consumer attributes each admitted user-message turn with a positive, sequential round number and the current revision; only these admitted `user/message` events advance `roundsStarted`. Replay rejects non-positive rounds, gaps, stale revisions, stopped phases, and cap overflow.

```ts type-equiv
/** Message attribution for admitted continuation rounds. */
interface GoalMessageSource {
  readonly kind: 'goal'
  readonly goalId: GoalId
  readonly revision: number
  /** Positive admitted continuation round. */
  readonly round: number
}
```

## Requests and notifications

Creation separates caller omission from the deployment choice, which `create()` resolves internally. An edit is a partial replacement whose runtime validator requires at least one field. Every mutation notification carries the accepted operation and exact revision; clear omits `goal`.

```ts type-equiv
/** Input whose omitted round cap is resolved by the service configuration. */
interface CreateGoalRequest {
  readonly objective: string
  readonly maxGoalRounds?: number
}
```

```ts type-equiv
/** Fields changed by an edit; at least one must be present. */
interface EditGoalRequest {
  readonly objective?: string
  readonly maxGoalRounds?: number
}
```

```ts type-equiv
/** Live notification after one durable goal mutation commits. */
interface GoalChanged {
  readonly operation: GoalOperation
  readonly ref: GoalRef
  /** Absent for a clear tombstone. */
  readonly goal?: GoalView
}
```

## Service behavior

[`GoalService`](../../packages/goal/goal/src/index.ts) resolves creation defaults, reads strict replay from the optionally registered `goal` projection, enforces exact-live-agent identity and compare-and-set mutations, and emits contained `goal/changed` notifications. Its first dependent access fails if the projection registry or key is absent. The package [README](../../packages/goal/goal/README.md) defines the callable API and model-visible contract.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdigest--digestservice"></a>

### `ctx.digest` — `DigestService`

Service published as `ctx.digest`.

```ts cordis-catalog
/**
 * Gather the day's facts for one workspace from every mounted seam.
 * @param cwd - the workspace directory.
 * @param at - the moment that defines the day; defaults to now.
 * @returns the report input.
 */
collect(cwd: string, at?: Date): Promise<DigestInput>

/**
 * Render and write the day's report to `<cwd>/.dsh/reports/<date>.md`.
 * @param cwd - the workspace directory.
 * @param at - the moment that defines the day; defaults to now.
 * @returns the written report.
 */
write(cwd: string, at?: Date): Promise<DigestReport>

/**
 * Gather the last seven days for one workspace from the daily report footers and live seams.
 * @param cwd - the workspace directory.
 * @param at - the moment that defines the last day; defaults to now.
 * @returns the weekly review input.
 */
collectWeek(cwd: string, at?: Date): Promise<WeeklyInput>

/**
 * Render and write the weekly review to `<cwd>/.dsh/reports/week-<YYYY-Www>.md`.
 * @param cwd - the workspace directory.
 * @param at - the moment that defines the last day; defaults to now.
 * @returns the written review.
 */
writeWeek(cwd: string, at?: Date): Promise<WeeklyReport>
```

Source: [`packages/goal/digest/src/types.ts`](../../packages/goal/digest/src/types.ts)

<a id="ctxgoals--goalservice"></a>

### `ctx.goals` — `GoalService`

Goal service (`ctx.goals`) backed exclusively by the owning session log.

```ts cordis-catalog
/**
 * Read the current goal for one exact live agent.
 * @param agent - owning live agent.
 * @returns a fresh view or `undefined` when no goal is current.
 * @throws {@link GoalError} when the agent is not the registry's live instance.
 */
@Remote('get') get(agent: Agent): GoalView | undefined

/**
 * Remove process-local continuation authority without changing durable goal
 * phase or revision. Lifecycle owners use this before unloading a driver;
 * a later human-authorized {@link resume} records the new activation edge.
 * @param agent - owning live agent.
 * @returns a fresh disarmed view, or `undefined` when no goal is current.
 */
disarm(agent: Agent): GoalView | undefined

/**
 * Create and arm a goal. A completed goal may be replaced; every other
 * current phase must be cleared or resumed instead.
 * @param agent - owning live agent.
 * @param request - objective and optional round cap.
 * @returns the created live view.
 */
create(agent: Agent, request: CreateGoalRequest): GoalView

/**
 * Edit objective and/or round cap without changing phase.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @param request - at least one replacement field.
 * @returns the edited view.
 */
@Remote('edit') edit(agent: Agent, ref: GoalRef, request: EditGoalRequest): GoalView

/**
 * Pause an active goal and disarm automatic continuation.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the paused view.
 */
@Remote('pause') pause(agent: Agent, ref: GoalRef): GoalView

/**
 * Resume and arm a stopped goal, or rearm an active goal after a
 * session-start edge, while its round budget still has capacity.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the active view.
 */
@Remote('resume') resume(agent: Agent, ref: GoalRef): GoalView

/**
 * Mark a current non-complete goal complete and disarm it.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the completed view.
 */
@Remote('complete') complete(agent: Agent, ref: GoalRef): GoalView

/**
 * Mark an active goal blocked and disarm it.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @param reason - policy-owned stable code and human-readable explanation.
 * @returns the blocked view with its durable reason.
 */
block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView

/**
 * Clear the current goal while retaining a durable tombstone and history.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the tombstone ref whose revision is one past the cleared snapshot.
 */
@Remote('clear') clear(agent: Agent, ref: GoalRef): GoalRef

/**
 * Create one Goal through the remote boundary.
 * @param agent - exact live Agent resolved from the wire identity.
 * @param request - objective and optional round cap.
 * @returns the created Goal identity.
 */
@Remote('create') remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult
```

Types: [Agent](core.md)

Source: [`packages/goal/goal/src/index.ts`](../../packages/goal/goal/src/index.ts)

<a id="ctxresearch--researchservice"></a>

### `ctx.research` — `ResearchService`

Service published as `ctx.research`.

```ts cordis-catalog
/**
 * The journal store of one workspace, opened on first use.
 * @param cwd - the workspace directory.
 * @returns the store; await `whenReady()` before reading.
 */
storeFor(cwd: string): JournalStore

/**
 * The research a live session's goal works on.
 * @param sessionId - the session.
 * @returns the slug and workspace, or `undefined` when the session has no research goal.
 */
activeFor(sessionId: SessionId): ActiveResearch | undefined

/**
 * Record a finding from an automated source.
 * @param finding - the finding and its journal.
 * @param source - who recorded it.
 * @returns resolves once the journal file is written.
 */
record(finding: ResearchFinding, source: JournalEntrySource): Promise<void>

/**
 * Announce one breakthrough, when `notify` is mounted.
 * @param journal - the journal the breakthrough belongs to.
 * @param text - the breakthrough text.
 */
announceBreakthrough(journal: Journal, text: string): void

/**
 * Re-rank a journal's open hypotheses with one logged scoring request. A
 * disabled scoring config, an absent route, a failed request, and an
 * unreadable answer are each logged and leave the recorded scores unchanged.
 * @param store - the store holding the journal.
 * @param slug - the journal slug.
 * @param session - session the request is logged against and whose route is reused by default.
 * @param signal - cancellation of the caller's tool call or round.
 * @returns resolves once the scores are written or the attempt is abandoned.
 */
scoreHypotheses(store: JournalStore, slug: string, session: Session, signal: AbortSignal): Promise<void>
```

Types: [Session](session.md) · [SessionId](core.md)

Source: [`packages/goal/research/src/types.ts`](../../packages/goal/research/src/types.ts)

<a id="goal-events"></a>

### `goal/*` events

<a id="goalactivation-changed--emit"></a>

#### `goal/activation-changed` — emit

Process-local goal activation changed for one session.

```ts cordis-catalog
/**
 * Process-local goal activation changed for one session.
 * @mode emit
 * @param payload - session id and the exact current goal activation, or no goal after a clear.
 */
'goal/activation-changed'(payload: GoalActivationChanged): void
```

Source: [`packages/goal/goal/src/types.ts`](../../packages/goal/goal/src/types.ts)

<a id="goalchanged--emit"></a>

#### `goal/changed` — emit

Goal mutation accepted by one live agent. The matching `goal/change` session event has already committed. Listener failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.

```ts cordis-catalog
/**
 * Goal mutation accepted by one live agent. The matching `goal/change`
 * session event has already committed. Listener failures are contained.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @param payload.agent - agent whose session owns the goal.
 * @param payload.change - fresh current projection or clear tombstone.
 * @mode emit
 */
'goal/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: GoalChanged }): void
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/goal/goal/src/domain.ts`](../../packages/goal/goal/src/domain.ts)

<a id="research-events"></a>

### `research/*` events

<a id="researchchange--emit"></a>

#### `research/change` — emit

One journal file was written by this process or changed on disk.

```ts cordis-catalog
/**
 * One journal file was written by this process or changed on disk.
 * @param payload.dir - absolute research directory.
 * @param payload.slug - the journal slug.
 * @mode emit
 */
'research/change'(payload: { dir: string; slug: string }): void
```

Source: [`packages/goal/research/src/index.ts`](../../packages/goal/research/src/index.ts)
<!-- END GENERATED cordis-surface -->
