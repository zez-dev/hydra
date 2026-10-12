/**
 * Re-arm an active goal when its session is resumed. Goal phase survives a
 * restart but the permission to run does not, so a resumed session with an
 * active goal does nothing until a human re-arms it; this plugin re-arms it
 * under a configured policy: `ask` puts the question to the approval service,
 * `always` re-arms unconditionally. Named exports preserve Loader injection
 * metadata.
 * @module @deepseek-ai/dsh-goal-resume-on-open
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: resolves the `ctx.goals` and `ctx.approval` service declarations.
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-user-approval'

export const name = 'goal-resume-on-open'
export const inject = ['goals', 'agents']

/** Resume policy configuration. */
export interface Config {
  /**
   * `ask` re-arms only after the approval service answers `allowed-once`;
   * `always` re-arms every active goal on resume without asking.
   */
  policy: 'ask' | 'always'
}

/** Schemastery configuration schema; the policy is a required deployment choice. */
export const Config: z<Config> = z.object({
  policy: z.union(['ask', 'always'] as const).required(),
})

/** What one re-arm attempt did. */
export type RearmOutcome = 'resumed' | 'skipped' | 'declined' | 'unavailable' | 'failed'

/** Tool name under which the approval question is recorded and presented. */
export const RESUME_APPROVAL_TOOL = 'goal_resume'

/**
 * Re-arm the agent's active goal under the policy.
 * @param ctx - context carrying `goals` and, for `ask`, an optional `approval` service.
 * @param config - the resume policy.
 * @param agent - the resumed live agent.
 * @returns `resumed` after a successful re-arm; `skipped` when there is no active disarmed goal;
 *   `declined` when the human answered anything but allow; `unavailable` when `ask` finds no
 *   approval service; `failed` when the goal service rejected the resume.
 */
export async function rearmOnOpen(ctx: Context, config: Config, agent: Agent): Promise<RearmOutcome> {
  const goal = ctx.goals.get(agent)
  if (goal === undefined || goal.phase !== 'active' || goal.activation === 'armed') return 'skipped'
  if (config.policy === 'ask') {
    const approval = ctx.get('approval')
    if (approval === undefined) {
      ctx.logger.warn(`goal-resume-on-open: no approval service; goal "${goal.id}" of "${agent.id}" stays disarmed`)
      return 'unavailable'
    }
    const outcome = await approval.request({
      agent,
      toolName: RESUME_APPROVAL_TOOL,
      reason: `Resume the active goal "${goal.objective}" now that this session is open? Rounds run until the goal completes or its budget is spent.`,
    })
    if (outcome !== 'allowed-once') return 'declined'
  }
  const current = ctx.goals.get(agent)
  if (current === undefined || current.phase !== 'active' || current.activation === 'armed') return 'skipped'
  try {
    ctx.goals.resume(agent, { id: current.id, revision: current.revision })
  } catch (error) {
    ctx.logger.warn(`goal-resume-on-open: could not resume goal "${current.id}" of "${agent.id}": ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
  return 'resumed'
}

/**
 * Install the `agent/created` listener. Only `resume` announcements qualify:
 * fresh, cleared, compacted, forked, and subagent sessions start with
 * `startup`, `clear`, or `compact`. The re-arm is deferred past the
 * announcement so the agent is published before any approval question is
 * routed to it.
 * @param ctx - plugin context carrying `goals` and `agents`.
 * @param config - the resume policy.
 */
export function apply(ctx: Context, config: Config): void {
  const pending = new Set<ReturnType<typeof setTimeout>>()
  ctx.effect(() => () => {
    for (const timer of pending) clearTimeout(timer)
    pending.clear()
  })
  ctx.on('agent/created', ({ agent, source }) => {
    if (source !== 'resume') return
    const goal = ctx.goals.get(agent)
    if (goal === undefined || goal.phase !== 'active' || goal.activation === 'armed') return
    const timer = setTimeout(() => {
      pending.delete(timer)
      if (ctx.agents.get(agent.id) !== agent) return
      void rearmOnOpen(ctx, config, agent).then((outcome) => {
        ctx.logger.info(`goal-resume-on-open: ${outcome} for "${agent.id}"`)
      })
    }, 0)
    pending.add(timer)
  })
}
