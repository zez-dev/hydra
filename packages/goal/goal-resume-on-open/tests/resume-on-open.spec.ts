import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import GoalService from '@deepseek-ai/dsh-goal'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import * as ResumeOnOpen from '@deepseek-ai/dsh-goal-resume-on-open'
import { rearmOnOpen } from '@deepseek-ai/dsh-goal-resume-on-open'

interface Harness {
  ctx: Context
  agent: Agent
  session: Session
  asked: ApprovalRequest[]
}

function stubAgent(ctx: Context, rawId: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(rawId))
  const scope = ctx.plugin(() => {})
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: createInboxStub(), ctx: scope.ctx, status: 'idle',
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, session }
}

async function harness(config: ResumeOnOpen.Config, answer?: ApprovalOutcome): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  const asked: ApprovalRequest[] = []
  if (answer !== undefined) {
    ctx.provide('approval', { request: async (req: ApprovalRequest) => { asked.push(req); return answer } })
  }
  await ctx.plugin(ResumeOnOpen, config)
  const { agent, session } = stubAgent(ctx, `resume-${Math.random()}`)
  await ctx.agents.register(agent)
  return { ctx, agent, session, asked }
}

async function announceResume(ctx: Context, agent: Agent): Promise<void> {
  await ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'resume' })
  // The listener defers past the announcement so the agent is published first.
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('rearmOnOpen', () => {
  it('re-arms an active but disarmed goal under policy always', async () => {
    const { ctx, agent } = await harness({ policy: 'always' })
    const created = ctx.goals.create(agent, { objective: 'ship it' })
    ctx.goals.disarm(agent)
    expect(await rearmOnOpen(ctx, { policy: 'always' }, agent)).toBe('resumed')
    const goal = ctx.goals.get(agent)!
    expect(goal).toMatchObject({ phase: 'active', activation: 'armed' })
    expect(goal.revision).toBe(created.revision + 1)
  })

  it('skips sessions with no goal, a non-active goal, or an already armed goal', async () => {
    const { ctx, agent } = await harness({ policy: 'always' })
    expect(await rearmOnOpen(ctx, { policy: 'always' }, agent)).toBe('skipped')
    const created = ctx.goals.create(agent, { objective: 'ship it' })
    expect(await rearmOnOpen(ctx, { policy: 'always' }, agent)).toBe('skipped')
    ctx.goals.pause(agent, created)
    expect(await rearmOnOpen(ctx, { policy: 'always' }, agent)).toBe('skipped')
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('asks the approval service under policy ask and re-arms only when allowed', async () => {
    const allowed = await harness({ policy: 'ask' }, 'allowed-once')
    ctx_disarmed(allowed)
    expect(await rearmOnOpen(allowed.ctx, { policy: 'ask' }, allowed.agent)).toBe('resumed')
    expect(allowed.asked).toHaveLength(1)
    expect(allowed.asked[0]!.agent).toBe(allowed.agent)
    expect(allowed.asked[0]!.toolName).toBe('goal_resume')
    expect(allowed.asked[0]!.reason).toContain('ship it')

    const rejected = await harness({ policy: 'ask' }, 'rejected')
    ctx_disarmed(rejected)
    expect(await rearmOnOpen(rejected.ctx, { policy: 'ask' }, rejected.agent)).toBe('declined')
    expect(rejected.ctx.goals.get(rejected.agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
  })

  it('leaves the goal disarmed under policy ask when no approval service is mounted', async () => {
    const h = await harness({ policy: 'ask' })
    ctx_disarmed(h)
    expect(await rearmOnOpen(h.ctx, { policy: 'ask' }, h.agent)).toBe('unavailable')
    expect(h.ctx.goals.get(h.agent)).toMatchObject({ activation: 'disarmed' })
  })
})

function ctx_disarmed(h: Harness): void {
  h.ctx.goals.create(h.agent, { objective: 'ship it' })
  h.ctx.goals.disarm(h.agent)
}

describe('agent/created listener', () => {
  it('re-arms on a resume announcement and ignores other sources', async () => {
    const h = await harness({ policy: 'always' })
    ctx_disarmed(h)
    await h.ctx.serial(scopeTarget(h.agent, h.agent), 'agent/created', { agent: h.agent, source: 'startup' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.ctx.goals.get(h.agent)).toMatchObject({ activation: 'disarmed' })
    await announceResume(h.ctx, h.agent)
    expect(h.ctx.goals.get(h.agent)).toMatchObject({ phase: 'active', activation: 'armed' })
  })
})
