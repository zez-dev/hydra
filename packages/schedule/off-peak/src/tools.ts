/** Agent-facing off-peak parking over the same queue `/offpeak` inspects. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Required services for the off-peak tool. */
export const inject = ['tools', 'offPeak']

/**
 * Register the model-facing `off_peak` tool, only while the off-peak row is
 * enabled: a disabled row never opens a window or drains on its own, so work
 * the model parked would wait for a human's `/offpeak drain`, and every request
 * would still pay for the tool's schema.
 * @param ctx Agent-scoped tool registration context.
 */
export function apply(ctx: Context): void {
  const service = ctx.offPeak
  if (!service.enabled) return
  ctx.tools.register(defineTool({
    name: 'off_peak',
    description: 'Park non-urgent work for the next off-peak window, or list what is already queued. '
      + 'Use `queue` when a task is worth doing but not now; the session resumes it when the window opens.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['queue', 'list'],
        description: 'queue (park a task) | list (what is queued)',
      },
      task: { type: 'string', description: 'What to do when the window opens; required for `queue`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          open: { type: 'boolean', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                state: { type: 'string', required: true },
                task: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.open
          ? `Off-peak window open; ${String(value.entries.length)} queued.`
          : `Off-peak window closed; ${String(value.entries.length)} queued.`,
      }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('off_peak needs an owning session')
      if (args.action === 'queue') {
        const task = args.task?.trim() ?? ''
        if (task.length === 0) throw new Error('queue needs a task')
        const cwd = agent.session.header.cwd
        await service.queue({ sessionId: agent.id, objective: task, ...cwd === undefined ? {} : { cwd } })
      }
      return {
        open: service.isOpen(),
        entries: service.list().map(entry => ({ id: entry.id, state: entry.state, task: entry.objective ?? '' })),
      }
    },
  }))
}
