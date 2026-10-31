import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService, { TeamError, TeamId, TeamMessageId } from '../src/index.ts'
import type { TeamMemberView } from '../src/index.ts'
import { TurnQueue } from '../src/turns.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Model whose requests wait until the test answers them. It records the order
 * in which Sessions start requests and the most non-Lead requests ever in
 * flight at once.
 */
class TurnAdapter extends LlmAdapter {
  /** Session ids in request-start order. */
  readonly started: string[] = []
  readonly inFlight = new Set<string>()
  maxTeammatesInFlight = 0
  /** Answers every later request without waiting for the test. */
  auto: ((options: GenerateOptions) => Promise<StreamChunk[]>) | undefined
  private readonly answers = new Map<string, PromiseWithResolvers<StreamChunk[]>>()

  constructor(private readonly leadId: string) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const id = String(options.sessionId)
    this.started.push(id)
    this.inFlight.add(id)
    this.maxTeammatesInFlight = Math.max(
      this.maxTeammatesInFlight,
      [...this.inFlight].filter(candidate => candidate !== this.leadId).length,
    )
    const answer = Promise.withResolvers<StreamChunk[]>()
    const onAbort = (): void => { answer.reject(new Error('aborted')) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    this.answers.set(id, answer)
    try {
      if (this.auto !== undefined) void this.auto(options).then(answer.resolve, answer.reject)
      for (const chunk of await answer.promise) yield chunk
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      this.answers.delete(id)
      this.inFlight.delete(id)
    }
  }

  /**
   * Answer one Session's request with text once that request is in flight.
   * @param id - Session whose request is answered.
   * @param text - assistant reply that ends the turn.
   */
  async reply(id: string, text: string): Promise<void> {
    await vi.waitFor(() => { expect(this.answers.has(id)).toBe(true) }, { timeout: 5_000 })
    this.answers.get(id)?.resolve(textResponse(text))
  }

  /** Requests started by Sessions other than the Lead, in order. */
  teammateRequests(): string[] {
    return this.started.filter(id => id !== this.leadId)
  }
}

async function setup(config: ConstructorParameters<typeof TeamService>[1] = { takeTurns: true }) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-turns-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const teamFiber = await ctx.plugin(TeamService, config)
  const leadId = SessionId('turns-lead')
  const adapter = new TurnAdapter(leadId)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(leadId, { provider: 'mock', model: 'mock' })
  return { ctx, lead, adapter, teamFiber }
}

function content(text: string) {
  return [{ type: 'text' as const, text }]
}

function message(text: string) {
  return createUserMessage({ content: content(text), source: { kind: 'user' } })
}

async function spawn(ctx: Context, lead: Agent, name: string): Promise<TeamMemberView> {
  return (await ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: `${name} responsibility`,
    prompt: content(`${name} initial`),
    context: 'fresh',
    provider: 'spawn',
    signal: SIGNAL,
  })).member
}

function live(ctx: Context, id: SessionId): Agent {
  const agent = ctx.agents.get(id)
  if (agent === undefined) throw new Error(`agent "${id}" is not live`)
  return agent
}

function statusOf(ctx: Context, lead: Agent, name: string): TeamMemberView['status'] | undefined {
  return ctx.agentTeams.listMembers(lead).find(member => member.name === name)?.status
}

async function waitStatus(ctx: Context, lead: Agent, name: string, status: TeamMemberView['status']): Promise<void> {
  await vi.waitFor(() => { expect(statusOf(ctx, lead, name)).toBe(status) }, { timeout: 5_000 })
}

async function waitInFlight(adapter: TurnAdapter, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(adapter.inFlight.has(id)).toBe(true) }, { timeout: 5_000 })
}

async function waitGone(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

/**
 * Keep one Agent resident in maintenance from its next idle edge until the
 * returned release runs, as other maintenance such as compaction would.
 */
function parkAtIdle(ctx: Context, agent: Agent): () => void {
  const done = Promise.withResolvers<undefined>()
  const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject !== agent || status !== 'idle') return
    stop()
    void agent.runMaintenance(() => done.promise)
  })
  return () => { done.resolve(undefined) }
}

/** Text blocks of every user message in one request, in request order. */
function requestText(options: GenerateOptions): string[] {
  return options.messages.flatMap(entry => entry.role === 'user'
    ? entry.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

async function storedEvents(ctx: Context, id: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

describe('Team turn-taking', () => {
  it('keeps teammates parallel by default', async () => {
    const { ctx, lead, adapter } = await setup({})
    expect(ctx.agentTeams.takeTurns).toBe(false)
    const alpha = await spawn(ctx, lead, 'alpha')
    const beta = await spawn(ctx, lead, 'beta')
    expect([alpha.status, beta.status]).toEqual(['running', 'running'])
    await vi.waitFor(() => { expect(adapter.inFlight).toEqual(new Set([alpha.id, beta.id])) })
    expect(adapter.maxTeammatesInFlight).toBe(2)
    await expect(ctx.agentTeams.waitForChange(lead, 9_999, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_INVALID_TIMEOUT' })
  })

  it('runs one teammate at a time while the Lead keeps working', async () => {
    const { ctx, lead, adapter } = await setup()
    expect(ctx.agentTeams.takeTurns).toBe(true)
    lead.followup(message('lead task'))
    const alpha = await spawn(ctx, lead, 'alpha')
    const beta = await spawn(ctx, lead, 'beta')
    expect([alpha.status, beta.status]).toEqual(['running', 'waiting'])
    await vi.waitFor(() => { expect(adapter.inFlight).toEqual(new Set([lead.id, alpha.id])) })
    expect(statusOf(ctx, lead, 'lead')).toBe('running')
    const betaAgent = live(ctx, beta.id)
    expect(betaAgent.status).toBe('idle')
    expect(betaAgent.inbox.nextTurn.map(entry => entry.content)).toEqual([content('beta initial')])
    await adapter.reply(lead.id, 'lead keeps working')
    await lead.whenIdle()
    expect(adapter.inFlight.has(beta.id)).toBe(false)
    await adapter.reply(alpha.id, 'alpha done')
    await waitInFlight(adapter, beta.id)
    expect(statusOf(ctx, lead, 'beta')).toBe('running')
    await adapter.reply(beta.id, 'beta done')
    await waitGone(ctx, beta.id)
    expect(adapter.teammateRequests()).toEqual([alpha.id, beta.id])
    expect(adapter.maxTeammatesInFlight).toBe(1)
  })

  it('hands the turn to the recipient of a message and back with its reply', async () => {
    const { ctx, lead, adapter } = await setup()
    const alpha = await spawn(ctx, lead, 'alpha')
    const beta = await spawn(ctx, lead, 'beta')
    await waitInFlight(adapter, alpha.id)
    await ctx.agentTeams.sendMessage(live(ctx, alpha.id), { target: 'beta', content: content('question'), signal: SIGNAL })
    expect(statusOf(ctx, lead, 'beta')).toBe('waiting')
    await ctx.sessions.flush(live(ctx, beta.id).session)
    const stored = await storedEvents(ctx, beta.id)
    expect(stored.filter(event => event.type === 'user/message')).toEqual([])
    expect(stored.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted.map(entry => entry.content)))
      .toEqual([content('beta initial'), [{ type: 'text', text: 'Team message from alpha:' }, ...content('question')]])
    await adapter.reply(alpha.id, 'alpha asked')
    await waitGone(ctx, alpha.id)
    await waitInFlight(adapter, beta.id)
    await ctx.agentTeams.sendMessage(live(ctx, beta.id), { target: 'alpha', content: content('answer'), signal: SIGNAL })
    await waitStatus(ctx, lead, 'alpha', 'waiting')
    await adapter.reply(beta.id, 'beta answered')
    await waitInFlight(adapter, alpha.id)
    await adapter.reply(alpha.id, 'alpha read the answer')
    await waitGone(ctx, alpha.id)
    expect(adapter.teammateRequests()).toEqual([alpha.id, beta.id, alpha.id])
    expect(adapter.maxTeammatesInFlight).toBe(1)
  })

  it('delivers every message in order without deadlock when three teammates message each other', async () => {
    const { ctx, lead, adapter } = await setup()
    const names = ['alpha', 'beta', 'gamma'] as const
    const spawned = Promise.withResolvers<undefined>()
    const ids = new Map<string, string>()
    const received = new Map<string, string[]>()
    const sent = new Set<string>()
    adapter.auto = async (options) => {
      await spawned.promise
      const id = String(options.sessionId)
      const name = ids.get(id)
      if (name === undefined) return textResponse('lead noted')
      received.set(name, requestText(options))
      if (!sent.has(name)) {
        sent.add(name)
        for (const target of names.filter(candidate => candidate !== name)) {
          await ctx.agentTeams.sendMessage(live(ctx, SessionId(id)), {
            target, content: content(`${name} to ${target}`), signal: SIGNAL,
          })
        }
      }
      return textResponse(`${name} done`)
    }
    for (const name of names) ids.set((await spawn(ctx, lead, name)).id, name)
    spawned.resolve(undefined)

    await vi.waitFor(() => {
      expect(adapter.teammateRequests().map(id => ids.get(id))).toEqual(['alpha', 'beta', 'gamma', 'alpha', 'beta'])
      for (const id of ids.keys()) expect(ctx.agents.get(SessionId(id))).toBeUndefined()
    }, { timeout: 10_000 })
    expect(adapter.maxTeammatesInFlight).toBe(1)
    for (const name of names) {
      expect(received.get(name)?.filter(text => text.endsWith(` to ${name}`)))
        .toEqual(names.filter(sender => sender !== name).map(sender => `${sender} to ${name}`))
    }
  })

  it('gives the turn away during a teammate wait and returns once the turn comes back', async () => {
    const { ctx, lead, adapter } = await setup()
    const alpha = await spawn(ctx, lead, 'alpha')
    const beta = await spawn(ctx, lead, 'beta')
    await waitInFlight(adapter, alpha.id)
    const alphaAgent = live(ctx, alpha.id)

    await expect(ctx.agentTeams.waitForChange(alphaAgent, 9_999, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_INVALID_TIMEOUT' })
    expect([statusOf(ctx, lead, 'alpha'), statusOf(ctx, lead, 'beta')]).toEqual(['running', 'waiting'])

    let returned = false
    const waiting = ctx.agentTeams.waitForChange(alphaAgent, 10_000, SIGNAL)
    void waiting.then(() => { returned = true })
    await waitInFlight(adapter, beta.id)
    await waitStatus(ctx, lead, 'alpha', 'waiting')
    expect(returned).toBe(false)
    const leadWait = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)
    await adapter.reply(beta.id, 'beta worked')
    await expect(leadWait).resolves.toEqual({ timedOut: false })
    await expect(waiting).resolves.toEqual({ timedOut: false })
    expect(statusOf(ctx, lead, 'alpha')).toBe('running')

    const cancelled = new AbortController()
    const aborted = ctx.agentTeams.waitForChange(alphaAgent, 10_000, cancelled.signal)
    cancelled.abort(new TeamError('stop waiting', 'TEST_CANCELLED'))
    await expect(aborted).rejects.toMatchObject({ code: 'TEST_CANCELLED' })
    await adapter.reply(alpha.id, 'alpha done')
    await waitGone(ctx, alpha.id)
  })

  it('keeps waiting teammates first in, first out', async () => {
    const { ctx, lead, adapter } = await setup()
    const alpha = await spawn(ctx, lead, 'alpha')
    const beta = await spawn(ctx, lead, 'beta')
    const gamma = await spawn(ctx, lead, 'gamma')
    await ctx.agentTeams.sendMessage(lead, { target: 'gamma', content: content('sent first'), signal: SIGNAL })
    await ctx.agentTeams.sendMessage(lead, { target: 'beta', content: content('sent second'), signal: SIGNAL })
    expect(ctx.agentTeams.listMembers(lead).map(member => member.status)).toEqual(['inactive', 'running', 'waiting', 'waiting'])
    await adapter.reply(alpha.id, 'alpha done')
    await waitInFlight(adapter, beta.id)
    expect(statusOf(ctx, lead, 'gamma')).toBe('waiting')
    await adapter.reply(beta.id, 'beta done')
    await adapter.reply(gamma.id, 'gamma done')
    await waitGone(ctx, gamma.id)
    expect(adapter.teammateRequests()).toEqual([alpha.id, beta.id, gamma.id])
  })

  it('leaves a waiting teammate in place when the Lead interrupts it', async () => {
    const { ctx, lead, adapter } = await setup()
    const alpha = await spawn(ctx, lead, 'alpha')
    const beta = await spawn(ctx, lead, 'beta')
    await waitInFlight(adapter, alpha.id)
    expect(ctx.agentTeams.interrupt(lead, 'beta')).toEqual({ previousStatus: 'waiting' })
    expect(statusOf(ctx, lead, 'beta')).toBe('waiting')
    expect(ctx.agentTeams.interrupt(lead, 'alpha')).toEqual({ previousStatus: 'running' })
    await waitInFlight(adapter, beta.id)
    await adapter.reply(beta.id, 'beta done')
    await waitGone(ctx, beta.id)
    expect(adapter.teammateRequests()).toEqual([alpha.id, beta.id])
  })

  it('passes a turn on when its input is removed or never wakes the teammate', async () => {
    const { ctx, lead, adapter } = await setup()
    const alpha = await spawn(ctx, lead, 'alpha')
    const beta = await spawn(ctx, lead, 'beta')
    const gamma = await spawn(ctx, lead, 'gamma')
    const betaAgent = live(ctx, beta.id)
    const [initial] = betaAgent.inbox.nextTurn
    if (initial === undefined) throw new Error('expected the initial prompt to wait in the inbox')
    expect(betaAgent.inbox.remove(initial.id)).toBe(true)
    await adapter.reply(alpha.id, 'alpha done')
    await waitInFlight(adapter, gamma.id)
    const gammaAgent = live(ctx, gamma.id)
    const releaseGamma = parkAtIdle(ctx, gammaAgent)
    await adapter.reply(gamma.id, 'gamma done')
    await vi.waitFor(() => { expect(gammaAgent.status).toBe('idle') })

    // Context injected into a parked teammate takes the free turn and returns it once the teammate is idle unwoken.
    gammaAgent.inject(message('context only'))
    expect(statusOf(ctx, lead, 'gamma')).toBe('running')
    releaseGamma()
    await waitStatus(ctx, lead, 'gamma', 'inactive')
    const delta = await spawn(ctx, lead, 'delta')
    expect(delta.status).toBe('running')
    await adapter.reply(delta.id, 'delta done')
    await waitGone(ctx, delta.id)
    expect(adapter.teammateRequests()).toEqual([alpha.id, gamma.id, delta.id])
  })

  it('keeps a grant for waking input that arrives while the grant is unused', async () => {
    const { ctx, lead, adapter } = await setup()
    const alpha = await spawn(ctx, lead, 'alpha')
    await waitInFlight(adapter, alpha.id)
    const alphaAgent = live(ctx, alpha.id)
    const releaseAlpha = parkAtIdle(ctx, alphaAgent)
    await adapter.reply(alpha.id, 'alpha done')
    await vi.waitFor(() => { expect(alphaAgent.status).toBe('idle') })
    alphaAgent.inject(message('context'))
    alphaAgent.steer(message('work'))
    const beta = await spawn(ctx, lead, 'beta')
    expect(beta.status).toBe('waiting')
    releaseAlpha()
    await waitInFlight(adapter, alpha.id)
    expect(statusOf(ctx, lead, 'beta')).toBe('waiting')
    await adapter.reply(alpha.id, 'alpha worked')
    await waitInFlight(adapter, beta.id)
    await adapter.reply(beta.id, 'beta done')
    await waitGone(ctx, beta.id)
    expect(adapter.teammateRequests()).toEqual([alpha.id, alpha.id, beta.id])
    expect(adapter.maxTeammatesInFlight).toBe(1)
  })

  it('holds a step that starts outside the turn until the turn passes', async () => {
    const { ctx, lead, adapter } = await setup()
    const alpha = await spawn(ctx, lead, 'alpha')
    const beta = await spawn(ctx, lead, 'beta')
    await waitInFlight(adapter, alpha.id)

    // A keep-inbox interrupt from the host ends beta's hold, and the latched wake starts its turn.
    ctx.subagents.interrupt(beta.id, { kind: 'user', parentSessionId: lead.id })
    await vi.waitFor(() => { expect(live(ctx, beta.id).status).toBe('running') })
    expect(statusOf(ctx, lead, 'beta')).toBe('waiting')
    expect(adapter.inFlight.has(beta.id)).toBe(false)

    // Other maintenance owns alpha when its message arrives, so no hold is installed.
    const alphaAgent = live(ctx, alpha.id)
    const releaseAlpha = parkAtIdle(ctx, alphaAgent)
    await adapter.reply(alpha.id, 'alpha done')
    await waitInFlight(adapter, beta.id)
    await ctx.agentTeams.sendMessage(lead, { target: 'alpha', content: content('more'), signal: SIGNAL })
    expect(statusOf(ctx, lead, 'alpha')).toBe('inactive')
    releaseAlpha()
    await vi.waitFor(() => { expect(alphaAgent.status).toBe('running') })
    expect(statusOf(ctx, lead, 'alpha')).toBe('waiting')
    await adapter.reply(beta.id, 'beta done')
    await waitInFlight(adapter, alpha.id)
    await adapter.reply(alpha.id, 'alpha done again')
    await waitGone(ctx, alpha.id)
    expect(adapter.teammateRequests()).toEqual([alpha.id, beta.id, alpha.id])
    expect(adapter.maxTeammatesInFlight).toBe(1)
  })

  it('never holds Agents outside the roster', async () => {
    const { ctx, lead, adapter } = await setup()
    const alpha = await spawn(ctx, lead, 'alpha')
    await waitInFlight(adapter, alpha.id)
    const ordinary = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'ordinary worker',
      request: { prompt: content('ordinary'), parent: lead },
      signal: SIGNAL,
    })
    await waitInFlight(adapter, ordinary.childId)
    await adapter.reply(ordinary.childId, 'ordinary done')
    await waitGone(ctx, ordinary.childId)

    const orphan = await ctx.agents.create({
      sessionId: SessionId('turns-orphan'),
      meta: { parentSession: SessionId('absent-parent') },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    orphan.agent.followup(message('orphan work'))
    await waitInFlight(adapter, orphan.agent.id)
    await adapter.reply(orphan.agent.id, 'orphan done')
    await orphan.agent.whenIdle()
    await orphan.dispose()

    // A failed Team projection leaves the gate idle; the unused grant still passes on.
    lead.session.append('team/message/delivered', {
      version: 2,
      teamId: TeamId(lead.id),
      messageId: TeamMessageId('unqueued-message'),
      targetId: lead.id,
    })
    await adapter.reply(alpha.id, 'alpha done')
    await waitGone(ctx, alpha.id)
  })

  it('releases turn waits on unload and gates again after the Team service reloads', async () => {
    const { ctx, lead, adapter, teamFiber } = await setup()
    const alpha = await spawn(ctx, lead, 'alpha')
    const beta = await spawn(ctx, lead, 'beta')
    await waitInFlight(adapter, alpha.id)
    const wait = ctx.agentTeams.waitForChange(live(ctx, alpha.id), 10_000, SIGNAL)
    await waitInFlight(adapter, beta.id)
    await waitStatus(ctx, lead, 'alpha', 'waiting')

    await teamFiber.dispose()

    expect(ctx.get('agentTeams')).toBeUndefined()
    await waitGone(ctx, alpha.id)
    await waitGone(ctx, beta.id)
    // Draining the working teammate passes the turn on, so the renewed turn wait ends with the wait result.
    await expect(wait).resolves.toEqual({ timedOut: false })

    // A pre-step listener left behind would fail every step on the closed queue.
    await ctx.plugin(TeamService, { takeTurns: true })
    await ctx.agentTeams.sendMessage(lead, { target: 'beta', content: content('after reload'), signal: SIGNAL })
    await ctx.agentTeams.sendMessage(lead, { target: 'alpha', content: content('after reload'), signal: SIGNAL })
    await waitInFlight(adapter, beta.id)
    expect(statusOf(ctx, lead, 'alpha')).toBe('waiting')
    await adapter.reply(beta.id, 'beta reloaded')
    await waitInFlight(adapter, alpha.id)
    await adapter.reply(alpha.id, 'alpha reloaded')
    await waitGone(ctx, alpha.id)
    expect(adapter.teammateRequests().slice(-2)).toEqual([beta.id, alpha.id])
  })
})

describe('Team turn queue', () => {
  const team = TeamId('turn-queue-team')
  const first = {} as Agent
  const second = {} as Agent
  const third = {} as Agent

  it('grants a free turn, queues later requests in order, and ignores stale releases', async () => {
    const queue = new TurnQueue()
    queue.release(team, first)
    queue.end(team, { agent: first })
    const grant = queue.take(team, first)
    if (grant === undefined) throw new Error('expected a free turn')
    expect(grant).toEqual({ agent: first })
    expect(queue.take(team, second)).toBeUndefined()
    const secondTurn = queue.acquire(team, second, SIGNAL)
    const thirdTurn = queue.acquire(team, third, SIGNAL)
    expect([queue.waiting(team, second), queue.waiting(team, third), queue.holds(team, first)]).toEqual([true, true, true])
    queue.release(team, second)
    queue.end(team, { agent: first })
    expect(queue.holds(team, first)).toBe(true)
    queue.end(team, grant)
    const secondGrant = await secondTurn
    expect(queue.holds(team, second)).toBe(true)
    queue.release(team, second)
    await expect(thirdTurn).resolves.toEqual({ agent: third })
    queue.end(team, secondGrant)
    queue.release(team, third)
    expect(queue.holds(team, third)).toBe(false)
    await expect(queue.acquire(team, first, SIGNAL)).resolves.toEqual({ agent: first })
  })

  it('leaves the queue on cancellation with the caller Error or a coded Team failure', async () => {
    const queue = new TurnQueue()
    queue.take(team, first)
    const failure = new Error('caller stopped')
    await expect(queue.acquire(team, second, AbortSignal.abort(failure))).rejects.toBe(failure)
    await expect(queue.acquire(team, second, AbortSignal.abort({ kind: 'parent' }))).rejects.toMatchObject({
      code: 'TEAM_TURN_ABORTED',
      message: "waiting for the Team turn aborted: { kind: 'parent' }",
    })
    const controller = new AbortController()
    const queued = queue.acquire(team, second, controller.signal)
    controller.abort('stop')
    await expect(queued).rejects.toMatchObject({ code: 'TEAM_TURN_ABORTED' })
    expect(queue.waiting(team, second)).toBe(false)
    queue.release(team, first)
    expect(queue.holds(team, second)).toBe(false)
  })

  it('releases a departing holder, rejects its waits, and closes for disposal', async () => {
    const queue = new TurnQueue()
    queue.take(team, first)
    const departing = queue.acquire(team, second, SIGNAL)
    const remaining = queue.acquire(team, third, SIGNAL)
    queue.forget(second)
    await expect(departing).rejects.toMatchObject({ code: 'TEAM_TURN_ABORTED' })
    queue.forget(first)
    await expect(remaining).resolves.toEqual({ agent: third })
    const other = TeamId('other-team')
    queue.take(other, first)
    const closed = queue.acquire(other, second, SIGNAL)
    queue.close()
    await expect(closed).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    expect(queue.holds(team, third)).toBe(false)
    await expect(queue.acquire(team, first, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
  })
})
