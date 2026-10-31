# Agent Note: Teammates that take turns

Status: implemented

English | [中文](2026-10-31-agent-team-take-turns.zh.md)

## Problem

[Agent Teams](2026-08-05-agent-teams.md) run teammates in parallel, up to the subagent service's `maxActiveSubagents` pool. Some deployments cannot or should not run several teammates at once: a provider plan may allow one concurrent request, and teammates editing one shared checkout can interleave conflicting work. Setting `maxActiveSubagents` to 1 serializes every continuable child, not only teammates, and a full pool rejects activation instead of queueing it. Teammates need to message each other and wait for replies without working at the same time. The rotation must not deadlock: an idle teammate and a teammate waiting for a reply cannot hold the turn, accepted messages keep their durable inbox order, and the Lead keeps working.

## Decision

`@deepseek-ai/dsh-experimental-agent-team` accepts `takeTurns`, which defaults to `false`. When it is `true`, the Team service owns one process-local turn per Team in `TurnQueue` (`src/turns.ts`): the current grant and a first-in-first-out list of waiting teammates. Only rostered teammates take part. The Lead and Agents outside the roster never wait for the turn.

`TeamTurnGate` enforces the turn at three points:

- **Inbox insertion.** On `agent/inbox/inserted` for an idle teammate, the gate takes a free turn or starts an Agent maintenance hold that waits for the turn. Delivery has already recorded the input in the durable inbox, and the Agent loop latches the input's wake until the hold ends. The forge worktree hold uses the same mechanism.
- **Step admission.** A prepended `agent/pre-step` listener makes a teammate step without the turn wait before any other step work. It covers wakes that bypass a hold: a host keep-inbox interrupt that cancels a hold, and input that arrives while other maintenance owns the teammate.
- **Waiting for Team activity.** `waitForChange()` registers its waiter, gives the caller's turn to the next waiting teammate, and waits for the turn again before it returns.

The turn passes at the holder's `agent/status` idle edge, when the holder leaves the registry, when `waitForChange()` gives it away, and once a grant's Agent is idle again without having used the grant. The roster reports queued teammates as `waiting` and the holder as `running`. Interrupting a waiting teammate cancels nothing and reports `previousStatus: 'waiting'`. `@deepseek-ai/dsh-experimental-tool-agent-team` adds a rotation paragraph to the policy and `waiting` to the `list_agents` and `wait_agent` descriptions only when the Team takes turns, so prompts of parallel Teams are unchanged.

## Deadlock freedom

No Team operation waits for the turn while it holds the turn. Sends return at inbox acceptance. Creation returns once the initial prompt is pending in the durable inbox, which a hold leaves in place. `waitForChange()` releases the turn before it waits, and the Lead never waits for the turn. A holder therefore reaches idle or a wait that releases the turn, and grants pass in first-in-first-out order, so every waiting teammate eventually works. A holder blocked for another reason, such as a long command or a prompt awaiting a human, delays the rotation without deadlocking it; the Lead can interrupt that holder.

## Alternatives considered

### Why not `maxActiveSubagents: 1`?

It limits every continuable child of the root, including ordinary subagents and workflow children. A full pool also rejects activation with `ACTIVATION_LIMIT_REACHED`, so a send to a stored teammate would fail instead of waiting for the turn.

### Why not gate only at `agent/pre-step`?

A step claims its input from the durable inbox before `agent/pre-step` runs and logs it as `user/message` only afterward. A turn wait there leaves the input in neither place, so cancellation or a crash during the wait loses it. `spawnTeammate()` would also block until the new teammate's turn, because provisioning waits until the initial prompt is pending or logged. The pre-step listener therefore remains only as the backstop for wakes that bypass a hold.

### Why not keep messages in the Team until the turn arrives?

`sendMessage()` would return before inbox acceptance, so it could no longer report the target inbox `MessageId`, and a restart would lose messages that Team does not persist.

### Why not include the Lead in the rotation?

The Lead runs the human's conversation; holding it would delay user prompts behind teammate work. Host code that joins children after a Lead turn, such as the headless runner, would also need its own release rules. Exempting the Lead keeps every Lead path free of turn waits.

### Why not a count such as `maxActiveTeammates`?

The requested behavior is one working teammate, and no consumer needs a cap between one and the subagent pool. The rotation, the `waiting` status, and the model-facing text are stated for one working teammate.

## Testing

`packages/experimental/agent-team/tests/take-turns.spec.ts` drives real Agents through a model whose requests wait for the test. It pins one teammate at a time while the Lead works, the handoff to a message recipient and back, three teammates messaging each other without deadlock and with per-inbox order, the `waitForChange()` handoff, first-in-first-out order, interrupting a waiting teammate, grants that are never used, the pre-step backstop, Agents outside the roster, and unload and reload. The same file unit-tests `TurnQueue`. `packages/experimental/tool-agent-team/tests/tool-team.spec.ts` pins every policy variant and the take-turns tool text verbatim and drives a `wait_agent` handoff through real tool calls. The `snapshots/session/team-take-turns` scenario replays the composition through `dsh --profile headless`: a writer holds the turn, a reviewer waits, and the writer's `wait_agent` hands the turn over and receives the reply.

## Consequences

The option buys sequential teammate work without changing message acceptance, durability, or the default parallel behavior. It costs these limits, which the package README records:

- The turn order is process-local. After a restart, messages a waiting teammate had accepted stay pending until the teammate receives another message.
- A teammate keeps the turn through long commands, slow model requests, and prompts that wait for a human.
- A step held at the pre-step backstop has claimed its input, which cancellation or process exit loses.
- The Web panel shows waiting teammates as inactive, because it derives activity from Session status.
- A teammate's own subagents are not part of the rotation.
