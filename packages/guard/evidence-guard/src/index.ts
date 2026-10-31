/**
 * Evidence standard: one system-prompt section that asks every model to read
 * a file in full or say which lines it read, to base each claim on what it read
 * or ran and cite the file and line or the command output, to write each
 * finding of a long task in a reply or a notes file rather than only in its
 * reasoning and count those notes as evidence after older tool output is cut,
 * to say when something is not verified instead of guessing, and to
 * re-check its claims before the final answer.
 * `@deepseek-ai/dsh-evidence-guard/review` steers the
 * end-of-turn review that makes the re-check happen. Named exports preserve
 * Loader injection metadata.
 * @module @deepseek-ai/dsh-evidence-guard
 */

import type { Context } from '@deepseek-ai/cordis'
// Resolves the `ctx.systemPrompt` service declaration.
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name; the plugin takes no configuration, and disabling its row removes the section. */
export const name = 'evidence-guard'
export const inject = ['systemPrompt']

/** Verbatim system-prompt section every agent receives. */
export const EVIDENCE_STANDARD_TEXT = 'Read a file in full before you describe or change it, or say which lines you read. '
  + 'Base each claim about files, code, or results on what you read or ran in this session, '
  + 'and cite the file and line or the command output. '
  + 'On long tasks, write each finding in your reply or in a notes file as soon as you find it, not only in your reasoning, '
  + 'because older tool output may be cut later to save context; '
  + 'findings you wrote down from your own reads and commands count as that evidence, '
  + 'so rely on them and re-read only what you need to check again. '
  + 'If you have not verified something, say so instead of guessing. '
  + 'Before your final answer, re-check your claims against that evidence and correct anything wrong.'

/**
 * Register the evidence-standard section in every agent's system prompt.
 * @param ctx - plugin context with the system-prompt service.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'evidence-standard',
    order: ctx.systemPrompt.getSectionOrder('EVIDENCE_STANDARD'),
    text: EVIDENCE_STANDARD_TEXT,
  })
}
