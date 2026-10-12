---
description: "Host and Client session control: create, resume, prompt, follow history, and project live session state."
kind: "package-reference"
---
# Session Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-session-controller` owns the Host `ctx.sessionController` service and the generated Client `session`, `skills`, and `fileReferences` Remote namespaces. It serves Session lifecycle and history, the Host-generation model catalog, workspace-path opening, user-invocable skill discovery, and Agent-scoped file references. Use it through API Gateway when a Client needs operations addressed by a Session.

## Table of Contents

- [Use this package](#use-this-package)
- [Client references](#client-references)
- [Session media references](#session-media-references)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

History pages and follow opening snapshots carry one `{ type: 'event', event: SessionWireEvent }` record per durable Session event. The Client retains each accepted record as one durable `SessionEventLikeEntry`; Assistant token boundaries remain inside the compact stream on `assistant/message` or `assistant/attempt`. Tool arguments, result content, failures, and `tool/result.data.meta` pass through unchanged; the controller does not resolve a Tool definition, run a presenter, or attach UI data.

The Client journal validates exact V3 event envelopes before publishing follow snapshots, live entries, or history pages. It reuses the browser-safe Session validators for required surface markers, exact replacement endpoints, earlier unique source seqs, embedded Assistant provider metadata, request-header omissions, and tool-error consistency. Invalid records fail without field stripping or normalization; range membership and source existence remain durable-log checks on the Host.

Each endpoint states its activation policy. List reads only stored headers and projection-cache rows: it never calls per-session stat or opens a cold Session body. A current-format cache identity may supply every list hint; a lifecycle-matching predecessor cache may supply only its version-compatible title as a stale display fact, never as an authoritative fold seed. Search, attachment, history pages, log following, skill discovery, and workspace-path opening can inspect persistence without activating an Agent; `canOpenWorkspacePath()` reports native-opening availability without addressing a Session. Cancellation requires live state; queue mutation, model, rename, prompt, and file-reference operations may resolve or resume an ordinary Session. Prompt rejects content with neither non-whitespace text nor an attachment before resolving the Agent or appending Session events; queue edits accept only non-empty text content. Prompt admission consumes opaque receipts from the injected [`fileUploads`](../../client/file-upload/README.md) Host service and resolves every same-Agent receipt before sending the complete ordered content list through `ctx.attachments`. Prompt retries whose `requestId` is already queued or logged return the original acceptance without inserting another message. Create and fork are the only operations that create a new Agent directly. The service applies one preset-aware resume policy and subagent ownership fence to its own methods and to the Typert Agent and Session lookups used by other Remote namespaces. Queue mutation has one narrow exception: a live child whose current projected identity is continuable and comes from its own non-seed suffix accepts the ordinary Edit, Remove, and QueueDock Steer actions across both inbox destinations. One-shot, missing, unknown, corrupt, seed-only, or cold children remain rejected without resume. The skill catalog uses a live Agent when present or the recorded preset's standing scope when cold, so listing never starts an Agent. The authenticated delivery routes use `workspaceDesktop()` for the serving Host name and file-manager behavior. `openWorkspacePath({ path, action: "reveal" })` delegates file-manager navigation to the native adapter; omitting `action` opens the default application.

`session.rewind` forks at the completed boundary right before the turn that holds `atSeq` (any event seq inside that turn), so the child ends where that turn began, and returns the child id plus that turn's first user prompt text. The first turn has no boundary before it and answers `session/rewind-unavailable`, as does an anchor past the log's end; an open tail turn is fine because the cut stays at the previous completed boundary. A rewound child is an ordinary fork (`parentSession` recorded, no extra header marker, so the sidebar lineage shows it as a fork). The Client `sessions.rewind` floors a fractional anchor, increments the inherited title when asked, and throws `SessionForkError` on refusal.

`session.delete` removes one stored Session and its derived state in one Host operation. A live Session this Host opened is closed first when its turn is settled: the controller keeps the disposal handle of every Agent it creates or resumes, and dropping that handle is what once left a Web Session live, and undeletable, until the Host exited. A Session whose turn is running, or one opened by another owner, is refused (`session/live`) and nothing is removed. The sub-agent Sessions it started (children through an uninterrupted chain of `origin: 'subagent'`) are deleted with it, deepest first, since they are hidden from the list and continuable only through their parent. Its forks, and everything under them, are kept: each fork holds its own copy of the history, so it stays a working Session whose `parentSession` names a Session that no longer exists, and lineage readers treat it as a root. With `cascade` every descendant goes first, deepest first. A closed Session that never wrote an event counts as removed rather than missing. Each removal deletes the stored log through `sessionPersistence.delete` (an active writer elsewhere answers `session/owned`), drops the projection-cache row, detaches the Session from its Workspace and the archive set, and announces `api-session/removed` so every Client drops the row. The Client `sessions.delete` removes every deleted row locally, sub-agent rows included, before the notification lands (a notification alone only marks a sub-agent row idle, since a sub-agent whose live Agent ended stays in its parent's catalog), and throws `SessionDeleteError` on refusal.

Client list refreshes retain unchanged row objects and reuse the items array when order and values match. Each row's `retainedBy` contains positive local reference-source counts; Host metadata refreshes cannot overwrite them. Cache membership checks use a per-refresh ID set, so reconciliation grows linearly with the current list and retained cache sizes.

The Client adapter exposes `SessionEventStream`, a Gateway `RemoteJournalStream` bound to one ordinary or direct-subagent address. It opens follow before the initial page, publishes only contiguous `replace`, `prepend`, `append`, and `settle-assistant` changes, and repairs reconnect or sequence gaps through a tail page. Backwards paging has two verbs: `loadOlder()` pulls one 50-message page, and `loadThrough(seq)` — the turn-jump loader — loops 200-message pages until the window covers the target seq, lowering a shared target on repeated calls, stopping on a page that makes no progress, and reporting busy through the same `loadingOlder` snapshot bit. The Web adapter explicitly opts into cursorless Assistant frames: each opening carries the active attempt's `startedAfterSeq`, `nextIndex`, and compact stream, and every stream member becomes a Client-only `assistant/live-chunk` entry ordered between durable cursors. The Host captures a follower-local arrival ordinal with that baseline and suppresses buffered frames at or before the cut; a replacement Agent may restart frame revision at one. A durable `assistant/message` or `assistant/attempt` arriving after an active opening stays staged only when its seq follows `startedAfterSeq` and its Turn and Step match; the matching end type, seq, and index publishes one named settlement delta that retires the attempt's transient rows and adds the durable entry while earlier same-step retries remain visible. Revision, dense-index, or settlement gaps for a known attempt reopen follow, while a controller that missed the start ignores unknown-attempt frames and publishes their durable settlement normally. An abandoned end publishes a settlement delta without a durable entry so its transient rows retire immediately. A durable gap-repair page has no Assistant baseline, so its held notification reopens follow once for a paired page and baseline. Every history record covers exactly its event seq. A durable `assistant/message` or `assistant/attempt` crosses the wire with its embedded token stream cut to what settled history reads: every packed run keeps its start time and its members up to the first non-empty fragment (reduced to one character), framing chunks stay, and block-end payloads lose their text and arguments, so first-token times answer as from the log while a long settlement's page bytes and the Client's retained heap follow the message content rather than the delta count. A business, persistence, or unresolved continuity failure terminates the stream, while only physical carrier loss selects automatic resumption. `SessionControlStream` is a Gateway `RemoteSnapshotStream`; every generation opens with a complete process-local baseline, so reconnect replaces jobs and projection state instead of treating transient values as durable events. At each ready Host generation, a synchronous Client subscription clears retained projection values and watermarks before refreshing queries and restarting the control stream, including Sessions absent from the control baseline. The first control stream waits for generation readiness, so its opening values cannot precede invalidation. Outstanding list responses from the previous generation cannot republish those values. Within a generation, a delayed control baseline cannot overwrite or clear newer list, history, or live values. The durable `inbox` projection carries both pending lists through the same cold-read and reconnect path as other projections. Client Agent contexts provide the identity used by the independent [`fileUpload`](../../client/file-upload/README.md) service; Session objects expose lifecycle, prompt, queue, and history operations rather than file transfer.

The Session object also carries local submission echoes: `session.beginSubmission` inserts one into `SessionSnapshot.pendingSubmissions` synchronously, before the caller serializes and prompts, so a conversation UI can show the message on the submit click's own frame. The echo stores ordered image previews and durable file references. Session derives its `transcript`, `queued`, or `steering` placement from the current running state and requested delivery mode, then retains that placement while serialization is in flight. The prompt's `requestId` is the correlation identity: the Host echoes it as the durable user source's `rpcId`, including pending messages in the `inbox` projection. An echo retires one animation frame after its durable event or queue occurrence is observed, immediately when its identified prompt fails or is abandoned, and as failed on disposal. Each retirement fires `onRetire` exactly once; an observed retirement includes the ordered durable attachment references so the composer can release successful cards while preserving failed drafts. Echoes are Client memory only; reload and reconnect rebuild the conversation from durable events alone.


The user-invocable `skills/list` metadata includes the winning provider’s optional instruction-file `path`. The composer can preview that file without loading every skill body or activating a cold Agent.

Fork copies history through the selected completed turn, including its `turn/end`. Events after that point, including queued input and model-setting changes, are excluded. An omitted or past-end anchor selects the last completed turn; an anchor inside an unfinished turn is rejected.

A resume blocked by an existing write handle returns `session/writer-held` with the Session id; other resume failures retain `gateway/internal`.

<a id="client-references"></a>
## Client references

`sessions.retain(target, { source, signal? })` immediately acquires one exact Client generation and starts its shared initial history opening. The target is a known Session id or a durable direct-parent subagent address; the Host validates an explicit address when history opens. The returned reference supports idempotent `release()` and `Symbol.dispose`; its `ready` Promise follows the shared `Session.open()` result and resolves to the exact binding when that attempt settles, including when a Remote failure is represented by `openState: 'error'`. It rejects when `Session.open()` rejects, its waiter is cancelled, or the reference is released early. Cancelling one waiter does not cancel another owner's opening. `sessions.using(target, options, operation)` waits for that settlement, holds its reference until the callback settles, and propagates rejected readiness and callback failures.

References keep local Session data, scoped Contexts, and history streams alive, not Host Agents. Final release withdraws the generation before teardown; later acquisition can create a new generation with the same id. `binding(id)` and `scope(id)` only borrow an existing generation. `retainInfo(id)` observes stable read-only source counts independently of catalog membership and performs no history I/O. Consumer source keys are declaration-merge extensible; navigation and completion acknowledgement belong to UI consumers, not this Controller. See [Client Session references](../../../.agents/notes/implemented/architecture/2026-09-15-client-session-references.md) for ownership and teardown rules.

<a id="session-media-references"></a>
## Session media references

`SessionMediaReferences` mounts `GET|HEAD /api/file?path=<absolute path>` on the authenticated `connection.fetch` channel when `connection`, `fs`, and `attachments` are composed. It reads ordinary files through `ctx.fs`, including temporary paths outside registered workspaces and files in remote providers. Neither directory containment nor MIME categories restrict access; `mime-types` supplies the response type, with `application/octet-stream` for unknown extensions. GET reuses `readBytes` for preflight and ongoing byte limits; HEAD reads metadata only. All files use `ctx.attachments.imageLimits.maxImageBytes` (normally 20 MiB); exceeding this limit returns 413. Responses contain the complete file, ignore Range, and carry `private, no-store`, `nosniff`, and a sandbox CSP so directly opened HTML/SVG cannot execute with the API origin. The Client rewrite lives in `ui-chat` (`AssistantMarkdown`); audio/video responses are available, while Markdown audio/video player nodes remain separate work.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `nativeOpen` | platform-detected | Whether Session workspace paths can be handed to a native desktop opener |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-session-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as invoked Agent commands own any model-visible effect.

#### KV Cache effect

No direct effect; model requests remain owned by the Agent and LLM packages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The image byte cap does not validate decoded dimensions or pixel count.
- Control baselines represent process-local state and therefore cannot reconstruct jobs after a Host restart.
- A failed follow resumption remains visible to the caller instead of retrying indefinitely.
- The raw browser upload is one streaming HTTP request without resumable offsets; a retry sends the file again from byte zero.
- File-reference completion uses the shared Agent lookup and can resume a cold Session; the `skills/list` catalog is the non-activating alternative for skill metadata.
- `session.delete` never interrupts a running turn and cannot close an Agent it did not open, so those two cases still refuse (an idle sub-agent child that its live parent still holds is the exception: the sub-agent service releases it first, and when that service is absent the refusal names the parent session to close); the Web UI offers no separate close, so a running Session is deletable only once its turn settles. Spill and attachment files are not removed, because those packages expose no per-session removal, and the SQLite search index drops the session only on its next observation. A kept fork can still read spill files its deleted parent wrote, so a per-session spill cleanup on delete would have to keep the files a fork references.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Every page and frame is checked against the addressed durable Session.
