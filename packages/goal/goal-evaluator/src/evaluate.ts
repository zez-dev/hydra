/**
 * Pure evaluation helpers: evidence collection from the session log and strict verdict parsing.
 * @module
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes'
import type { GoalVerdict } from './types.ts'

/** System prompt of the evaluation request, sent verbatim. */
export const EVALUATION_SYSTEM_PROMPT = [
  'You are an independent evaluator. An AI coding agent claims it has achieved its goal. Decide from the evidence alone whether the objective is actually achieved.',
  'Be strict: partial work, untested changes, or claims without visible evidence are "not-yet". Do not reward effort; judge the outcome against the objective.',
  'When recorded workspace changes are listed, weigh whether those file changes plausibly satisfy the objective; changes the tool results never verified count for little.',
  'Answer with JSON only: {"verdict": "achieved" | "not-yet", "reasons": [string]}. Each reason is one concrete sentence the agent can act on.',
].join('\n')

/**
 * Render the last `limit` tool results of a session log as evidence lines.
 * @param events - the session's events in sequence order.
 * @param limit - how many most-recent tool results to keep.
 * @param maxChars - per-result character cap; longer results are truncated with an ellipsis.
 * @returns evidence lines in log order, each `<tool>: <result text>`.
 */
export function collectEvidence(events: readonly SessionEvent[], limit: number, maxChars: number): string[] {
  const names = new Map<string, string>()
  const results: { callId: string; text: string }[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      names.set(event.data.callId, event.data.name)
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = event.data.message
    const text = message.content.map(part => part.type === 'text' ? part.text : `[${part.type}]`).join('')
    results.push({ callId: message.toolCallId, text })
  }
  return results.slice(-limit).map(({ callId, text }) => {
    const body = text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`
    return `${names.get(callId) ?? 'tool'}: ${body}`
  })
}

/**
 * Parse the evaluator's answer strictly, tolerating one fenced code block.
 * @param text - the model's text output.
 * @returns the verdict, or `undefined` when the answer is not a well-formed verdict.
 */
export function parseVerdict(text: string): GoalVerdict | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // Not JSON: the caller treats an unreadable verdict as a failed evaluation.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record.verdict !== 'achieved' && record.verdict !== 'not-yet') return undefined
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0).map(reason => reason.trim())
    : []
  return { verdict: record.verdict, reasons }
}

/**
 * Render recorded workspace changes as evidence lines, one per turn, oldest first.
 * @param summaries - per-turn change summaries in turn order.
 * @param maxEntries - files named per turn; the rest are counted.
 * @returns one line per summary; empty when nothing was recorded.
 */
export function renderWorkspaceEvidence(summaries: readonly WorkspaceChangesSummary[], maxEntries: number): string[] {
  return summaries.map((summary) => {
    const named = summary.files.slice(0, maxEntries).map(file => `${file.display} (+${file.added}/-${file.deleted})`)
    const rest = summary.total - named.length
    const files = [...named, ...rest > 0 ? [`and ${rest} more`] : []].join(', ')
    return `turn ${summary.turn}: ${summary.total} file${summary.total === 1 ? '' : 's'}, +${summary.added}/-${summary.deleted}: ${files}`
  })
}
