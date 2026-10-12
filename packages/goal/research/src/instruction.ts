/**
 * The research round instruction and `/research` input parsing.
 * @module
 */

import type { Journal } from './types.ts'

/** Objective prefix that marks a research goal; the slug follows, then `] `. */
export const RESEARCH_PREFIX = '[research:'

/**
 * The slug of a research goal objective.
 * @param objective - a goal objective.
 * @returns the slug, or `undefined` when the objective is not a research goal.
 */
export function researchSlugOf(objective: string): string | undefined {
  if (!objective.startsWith(RESEARCH_PREFIX)) return undefined
  const end = objective.indexOf(']', RESEARCH_PREFIX.length)
  if (end === -1) return undefined
  const slug = objective.slice(RESEARCH_PREFIX.length, end)
  return slug.length === 0 ? undefined : slug
}

/**
 * Compose a research goal objective.
 * @param slug - the journal slug.
 * @param objective - the human objective.
 * @returns `[research:<slug>] <objective>`.
 */
export function researchObjective(slug: string, objective: string): string {
  return `${RESEARCH_PREFIX}${slug}] ${objective}`
}

/** A parsed `/research` invocation. */
export type ResearchInput =
  | { readonly kind: 'start'; readonly objective: string; readonly criteria: readonly string[]; readonly slug?: string }
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'list' }
  | { readonly kind: 'continue'; readonly slug?: string }
  | { readonly kind: 'usage' }

/**
 * Parse `/research` input: `status`, `pause`, `resume`, `list`, `continue
 * [name]` (also `resume <name>`), or an objective with optional `--criteria
 * "a; b"` and `--slug name`; a `--slug` with no objective continues that journal.
 * @param raw - the text after the command name.
 * @returns the parsed input; `usage` when nothing usable was given.
 */
export function parseResearchInput(raw: string): ResearchInput {
  const text = raw.trim()
  if (text.length === 0) return { kind: 'usage' }
  if (text === 'status' || text === 'pause' || text === 'resume' || text === 'list') return { kind: text }
  if (text === 'continue') return { kind: 'continue' }
  if (/^(?:continue|resume)\s+\S+$/u.test(text)) return { kind: 'continue', slug: text.replace(/^\S+\s+/u, '') }
  let objective = text
  let criteria: string[] = []
  let slug: string | undefined
  const criteriaMatch = /(?:^|\s)--criteria\s+(?:"(?<quoted>[^"]*)"|(?<bare>\S+))/u.exec(objective)
  if (criteriaMatch !== null) {
    const value = criteriaMatch.groups?.['quoted'] ?? criteriaMatch.groups?.['bare'] ?? ''
    criteria = value.split(';').map(item => item.trim()).filter(item => item.length > 0)
    objective = objective.replace(criteriaMatch[0], '')
  }
  const slugMatch = /(?:^|\s)--slug\s+(?<slug>\S+)/u.exec(objective)
  if (slugMatch !== null) {
    slug = slugMatch.groups?.['slug']
    objective = objective.replace(slugMatch[0], '')
  }
  objective = objective.trim()
  if (objective.length === 0) return slug === undefined ? { kind: 'usage' } : { kind: 'continue', slug }
  return { kind: 'start', objective, criteria, ...slug === undefined ? {} : { slug } }
}

/**
 * Render the instruction appended to every research goal round.
 * @param journal - the journal the round works on.
 * @returns self-contained round text.
 */
export function renderResearchInstruction(journal: Journal): string {
  const open = [...journal.hypotheses.filter(entry => entry.status === 'open')]
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  const ranked = open.map(entry => entry.score === undefined
    ? entry.id
    : `${entry.id} (score ${entry.score}${entry.scoreReason === undefined || entry.scoreReason.length === 0 ? '' : `: ${entry.scoreReason}`})`)
  const best = open[0]
  return [
    'Role: researcher',
    `Objective: ${journal.objective}`,
    ...journal.criteria.length === 0 ? [] : ['Done when every criterion holds:', ...journal.criteria.map(criterion => `- ${criterion}`)],
    'This round:',
    '1. Read the <research_journal> block above; it is the complete state of this research. Do not repeat a dead end or an experiment already recorded.',
    journal.nextSteps.length === 0
      ? `2. ${best?.score === undefined
        ? 'Choose the most informative next experiment from the open hypotheses (or form one hypothesis if none is open) and record it with `journal` action `hypothesis`.'
        : `Test the highest-scored open hypothesis first, ${ranked[0]}; the open hypotheses ranked by support are: ${ranked.join('; ')}.`}`
      : `2. Take the first next step: ${journal.nextSteps[0]}${open.length === 0 ? '' : ` (open hypotheses by support: ${ranked.join('; ')})`}.`,
    '3. Run the experiment with the tools available; prefer `run_experiment` (it records the command, exit code, metrics, and deltas against the previous run of the same title in the journal for you); keep it small enough to finish this round.',
    '4. Record the outcome with `journal` action `experiment` (what and result), set the hypothesis status with action `hypothesis`, and record a `dead_end` for anything that must not be retried.',
    '5. The moment a result is a breakthrough toward the objective, record it with `journal` action `breakthrough` before anything else.',
    '6. Replace the next steps with `journal` action `next` so the following round starts without you, then stop.',
    'Call `update_goal` with action `complete` only when every criterion above holds and the journal shows the evidence.',
  ].join('\n')
}
