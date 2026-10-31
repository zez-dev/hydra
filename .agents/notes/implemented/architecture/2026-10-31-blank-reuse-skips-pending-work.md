# Agent Note: Blank Session reuse skips pending work

Status: implemented

English | [中文](2026-10-31-blank-reuse-skips-pending-work.zh.md)

## Problem

New Session reuses a blank Session, one that has started no turn, for the next conversation. A blank Session can still hold work that its log does not record: the composer's Send later control binds a Schedule task to the composer's Session, and the task delivers its prompt into that Session later. Reusing such a blank for an unrelated conversation delivers the scheduled prompt into that conversation.

## Decision

The caller that reuses any blank asks the Host to skip held ones. New Session, Workspace reopening, and draft preparation name the first eligible blank in catalog order with `skipActive`; `session.create` then reuses that blank only while the Workspace registry's `sessionActivity(sessionId)` reports nothing for it, otherwise creates another Session, and fails the creation when a provider rejects. `sessionActivity` asks the `workspace/session-activity` waterfall that archive admission already asks ([archive admission](../feature/2026-09-21-archive-stops-running-session-work.md)). Running turns, jobs, and subagents all require a started turn, so for a blank Session the answering provider is one whose work outlives turns: the Schedule plugin's active Host tasks. The API Session Controller names no activity family and imports nothing from the Schedule plugin.

A request without `skipActive` keeps the earlier rule: the named blank is reused whatever work it holds, so repeated requests naming one identity return it, as the upstream `schedule-timing` expected test requires for an identity bound to seeded task data. Startup restoration names the saved blank without `skipActive`, so a reload reopens a blank that holds pending work; once the user leaves it, the blank stays hidden like other blank rows until its first turn.

This decision extends the blank-reuse policy in the [writer acquisition record](2026-09-17-process-local-blank-sessions.md).

## Alternatives considered

**A Schedule check in the Session Controller.** It puts a business family into `packages/api`. The activity waterfall already lets each provider answer for its own work, and a later provider joins without a controller change.

**Skipping held blanks for every named request.** It needs no request field, but it breaks idempotent explicit-id adoption: a second `session.create` naming an identity bound to seeded task data returns a new Session, and a reload replaces the Session the user last showed.

**A pending-work fact in Session-list summaries.** Navigation could skip held blanks itself, but Schedule tasks are not Session events, so no Session projection can carry the fact. The fact would need its own invalidation whenever a provider's work changes, and the Host would still have to enforce the rule.

**The Host choosing among candidate blanks.** Sending every eligible blank and reusing the first free one avoids the extra Session after a decline, but it changes the `session.create` request, and restoration names one identity so that the Host can recreate an unstored blank under it.

## Consequences

New Session never hands a blank Session with an active task to another conversation, so Send later can schedule from a new chat, and a reload returns to that Session with its draft. When the first candidate holds work, New Session creates one more blank instead of searching further; a created Session leads the Client list, so the next New Session returns to it. A caller that names an identity without `skipActive` receives it even while it holds work. The placement rule's answer and the reuse are not one atomic step: a task bound to the named Session after the answer and before the reuse delivers into the reusing conversation.

## Verification

Session Controller tests decline a live and a stored blank that the registry reports work for under `skipActive`, reuse a held blank without it, and fail the creation when the activity question rejects. Navigation tests pin that a Workspace connection names its blank with `skipActive` and that restoration names its saved blank without it. A Workspace registry test pins the waterfall's answer order, its empty answer without providers, and that it writes nothing. The upstream `schedule-timing` expected test adopts an identity bound to seeded task data twice. A shipped Web-composition test binds a task to the selected blank and checks that New Session opens another Session and that a reload reopens the held blank with its draft and task.
