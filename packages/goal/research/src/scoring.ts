/**
 * Hypothesis scoring: the auxiliary request that re-ranks open hypotheses by
 * the evidence in the journal after each experiment, its strict answer format,
 * and the digest the scorer reads.
 * @module
 */

import type { Journal } from './types.ts'

/** One scorer verdict for a hypothesis. */
export interface HypothesisScore {
  readonly hypothesisId: string
  /** Support for the hypothesis in `[0, 1]`. */
  readonly score: number
  readonly reason: string
}

/** System prompt of the scoring request. */
export const SCORING_SYSTEM_PROMPT = [
  'You rank the open hypotheses of a research journal by how well the recorded experiments support them.',
  'Answer with a JSON array only. Each item is {"hypothesisId": string, "score": number, "reason": string}: score is 0 (refuted by the evidence) to 1 (strongly supported); reason is one sentence citing the experiments.',
  'Include every open hypothesis exactly once. Do not invent hypotheses or experiments.',
].join('\n')

/**
 * Render what the scorer reads: objective, criteria, open hypotheses with
 * their current scores, every experiment, and the dead ends.
 * @param journal - the journal.
 * @returns the request text.
 */
export function renderScoringRequest(journal: Journal): string {
  const open = journal.hypotheses.filter(entry => entry.status === 'open')
  const lines = [`Objective: ${journal.objective}`]
  if (journal.criteria.length > 0) lines.push('Done when:', ...journal.criteria.map(criterion => `- ${criterion}`))
  lines.push('Open hypotheses:')
  for (const entry of open) {
    lines.push(`- ${entry.id}: ${entry.text}${entry.score === undefined ? '' : ` (current score ${entry.score})`}`)
  }
  lines.push('Experiments (oldest first):')
  if (journal.experiments.length === 0) lines.push('- none yet')
  for (const entry of journal.experiments) {
    lines.push(`- ${entry.id}${entry.hypothesisId === undefined ? '' : ` for ${entry.hypothesisId}`}: ${entry.what} => ${entry.result}`)
  }
  if (journal.deadEnds.length > 0) lines.push('Dead ends:', ...journal.deadEnds.map(entry => `- ${entry.text}`))
  lines.push('Score every open hypothesis.')
  return lines.join('\n')
}

function stripFence(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)
  return (fenced?.[1] ?? text).trim()
}

/**
 * Parse the scorer's answer.
 * @param text - the model's text output.
 * @returns the well-formed items, or `undefined` when the answer is not a JSON array.
 */
export function parseScores(text: string): HypothesisScore[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(text))
  } catch {
    // Not JSON: the caller logs and keeps the existing scores.
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const scores: HypothesisScore[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const hypothesisId = record['hypothesisId']
    const score = record['score']
    const reason = record['reason']
    if (typeof hypothesisId !== 'string' || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) continue
    scores.push({ hypothesisId, score, reason: typeof reason === 'string' ? reason : '' })
  }
  return scores
}
