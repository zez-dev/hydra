/** Agent-facing environment self-check over the same service `/doctor` renders. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderReport } from './checks.ts'
import type { DoctorReport } from './types.ts'

/** Required services for the self-check tool. */
export const inject = ['tools', 'doctor']

/**
 * Register the read-only `doctor` tool.
 * @param ctx Agent-scoped tool registration context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'doctor',
    description: 'Read-only environment self-check of this Hydra installation: home, workspace folders, sandbox, native addon, git, '
      + 'mounted plugins, tool-calling compat rows, and credential references (never key values). Set probe to also send one tiny '
      + 'model request to the default route and report its latency or failure class.',
    parameters: {
      probe: { type: 'boolean', description: 'Also probe the default model route with one tiny request.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderReport(value as unknown as DoctorReport) }],
    },
    execute: async (args, exec) => {
      const report = await ctx.doctor.run({ probe: args.probe === true, ...exec.agent === undefined ? {} : { agent: exec.agent } })
      return report as unknown as Record<string, never>
    },
  }))
}
