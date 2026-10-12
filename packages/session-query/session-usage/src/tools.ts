/**
 * The model-facing `usage` tool over the same fold `/usage` renders.
 *
 * It ships as its own `./tools` entry so a composition can mount the service
 * and the command without putting the tool in every agent's tool layer.
 * @module @deepseek-ai/dsh-session-usage/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderUsageReport } from './render.ts'
import type { UsageReport } from './types.ts'

/** Required services for the usage tool. */
export const inject = ['tools', 'sessionUsage']

/**
 * Register the read-only `usage` tool.
 * @param ctx - Agent-scoped tool registration context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'usage',
    description: 'Read-only token usage across every recorded session: overall totals, a table by provider and model, '
      + 'and a per-day series. Counts what providers reported for assistant messages, bucketed by the local day each '
      + 'message happened. Use since and until to look at one stretch of days.',
    parameters: {
      since: { type: 'string', description: 'Inclusive first local day as YYYY-MM-DD. Omit for all recorded history.' },
      until: { type: 'string', description: 'Inclusive last local day as YYYY-MM-DD. Omit to run to the most recent day.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderUsageReport(value as unknown as UsageReport) }],
    },
    execute: async (args) => {
      const report = await ctx.sessionUsage.report({
        ...typeof args.since === 'string' ? { since: args.since } : {},
        ...typeof args.until === 'string' ? { until: args.until } : {},
      })
      return report as unknown as Record<string, never>
    },
  }))
}
