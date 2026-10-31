/** Fix the order in which the teammates' settlement notices reach the Lead. */
export const name = 'team-take-turns-notice-order'

/**
 * Hold the writer's closing step until the reviewer's settlement notice reached the
 * Lead, and hold the Lead's `go` command until both notices did, so the Lead claims
 * both notices in one step and in a fixed order.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario host context.
 */
export function apply(ctx) {
  const reviewerNoticed = Promise.withResolvers()
  const bothNoticed = Promise.withResolvers()
  const gates = [reviewerNoticed, bothNoticed]
  for (const gate of gates) void gate.promise.catch(() => undefined)
  ctx.effect(() => () => {
    for (const gate of gates) gate.reject(new Error('team-take-turns fixture disposed'))
  })
  const members = new Map()
  const noticed = new Set()

  const wait = async (gate, signal) => {
    signal.throwIfAborted()
    const cancelled = Promise.withResolvers()
    const abort = () => cancelled.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([gate.promise, cancelled.promise])
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  ctx.on('session/event', (_session, event) => {
    if (event.type === 'team/member') members.set(event.data.member.name, event.data.member.id)
  })
  ctx.on('agent/inbox/inserted', ({ message }) => {
    if (message.source.kind !== 'subagent-settled') return
    noticed.add(message.source.senderSessionId)
    if (noticed.has(members.get('reviewer'))) reviewerNoticed.resolve()
    if (noticed.size === 2) bothNoticed.resolve()
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    if (agent.id === members.get('writer') && turn === 1 && step === 4) await wait(reviewerNoticed, signal)
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.callId === 'turns-go') await wait(bothNoticed, exec.signal)
    return result
  })
}
