/**
 * Recall rendering: the `<research_journal>` block the model sees on every
 * step of a research session, its digest, and the message identity test the
 * pre-step listener uses to add, keep, or replace exactly one recall message.
 * Re-injecting the digest each step is what makes the journal survive
 * compaction: a compacted history still starts from the current breakthroughs.
 * @module
 */

import { createHash } from 'node:crypto'
import { createPluginRecallMessage, isPluginRecallMessage, messageText } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Journal } from './types.ts'

/** Plugin name recorded on every message this plugin injects. */
export const RESEARCH_PLUGIN = 'dsh-research'

const HEAD = '<research_journal>\n'
const TAIL = '\n</research_journal>'

/** What bounds the rendered recall. */
export interface RecallOptions {
  /** Byte cap on the complete block (UTF-8). */
  readonly maxRecallBytes: number
  /** How many most-recent experiments to include. */
  readonly recentExperiments: number
  /** Breakthroughs of other journals, as rendered lines; absent or empty adds no section. */
  readonly related?: readonly string[]
}

/** One section of the digest: its heading (absent for the opening lines), its lines oldest first, and its line when empty. */
interface RecallSection {
  readonly title?: string
  readonly lines: readonly string[]
  readonly empty?: string
  /** Whether newer lines come last and older ones are cut first. */
  readonly newestLast: boolean
}

/**
 * Render the journal digest: objective, criteria, breakthroughs, related
 * breakthroughs from other journals when supplied, open hypotheses, the most
 * recent experiments, dead ends, and next steps, in that order. Within the
 * byte cap the sections are filled by priority: the opening lines, next
 * steps, dead ends, criteria, open hypotheses, recent experiments, then
 * breakthroughs and related breakthroughs; a section cut short keeps its
 * newest lines and says how many more the journal file holds. The closing
 * tag always fits.
 * @param journal - the journal.
 * @param options - byte cap and experiment window.
 * @returns the block text.
 */
export function renderJournalRecall(journal: Journal, options: RecallOptions): string {
  const open = journal.hypotheses.filter(entry => entry.status === 'open')
  const recent = journal.experiments.slice(-options.recentExperiments)
  const intro: RecallSection = {
    newestLast: false,
    lines: [
      `Research: ${journal.objective} (journal "${journal.slug}", ${journal.status})`,
      'This journal is the durable memory of this research across sessions. Record every breakthrough, experiment result, and dead end with the `journal` tool the moment it happens; keep next steps current.',
    ],
  }
  const criteria: RecallSection = { title: 'Done when:', newestLast: false, lines: journal.criteria.map(criterion => `- ${criterion}`) }
  const breakthroughs: RecallSection = {
    title: 'Breakthroughs:', empty: '- none yet', newestLast: true, lines: journal.breakthroughs.map(entry => `- [${entry.id}] ${entry.text}`),
  }
  const related: RecallSection = { title: 'Related breakthroughs from other research:', newestLast: false, lines: (options.related ?? []).map(line => `- ${line}`) }
  const hypotheses: RecallSection = { title: 'Open hypotheses:', empty: '- none', newestLast: false, lines: open.map(entry => `- [${entry.id}] ${entry.text}`) }
  const experiments: RecallSection = {
    title: `Recent experiments (${recent.length} of ${journal.experiments.length}):`, empty: '- none yet', newestLast: true,
    lines: recent.map(entry => `- [${entry.id}] ${entry.what} => ${entry.result}`),
  }
  const deadEnds: RecallSection = { title: 'Dead ends (do not retry):', newestLast: true, lines: journal.deadEnds.map(entry => `- ${entry.text}`) }
  const next: RecallSection = {
    title: 'Next steps:', empty: '- decide the next experiment from the open hypotheses', newestLast: false, lines: journal.nextSteps.map(step => `- ${step}`),
  }
  // Every line is priced with a separating newline, which over-counts the block by one byte.
  const room = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
  const shown = new Map<RecallSection, string[]>()
  let bytes = Buffer.byteLength(HEAD) + Buffer.byteLength(TAIL)
  for (const section of [intro, next, deadEnds, criteria, hypotheses, experiments, breakthroughs, related]) {
    const top = section.title === undefined ? [] : [section.title]
    const whole = [...top, ...section.lines.length === 0 && section.empty !== undefined ? [section.empty] : [], ...section.lines]
    if (whole.length === top.length) continue
    if (bytes + room(whole) <= options.maxRecallBytes) {
      bytes += room(whole)
      shown.set(section, whole)
      continue
    }
    // Cut short: keep the lines that fit beside the heading and the line counting what was left out.
    let budget = options.maxRecallBytes - bytes - room(top) - (section === intro ? 0 : room([omitted(section, section.lines.length)]))
    const kept: string[] = []
    for (const line of section.newestLast ? [...section.lines].reverse() : section.lines) {
      if (room([line]) > budget) break
      budget -= room([line])
      kept.push(line)
    }
    if (kept.length === 0) continue
    const note = section === intro ? [] : [omitted(section, section.lines.length - kept.length)]
    bytes += room([...top, ...kept, ...note])
    shown.set(section, section.newestLast ? [...top, ...note, ...kept.reverse()] : [...top, ...kept, ...note])
  }
  const body = [intro, criteria, breakthroughs, related, hypotheses, experiments, deadEnds, next]
    .flatMap(section => shown.get(section) ?? [])
  return `${HEAD}${body.join('\n')}${TAIL}`
}

/**
 * The line standing for the lines a section left out.
 * @param section - the section cut short.
 * @param count - how many lines it left out.
 * @returns `- (N older|more in the journal file)`.
 */
function omitted(section: RecallSection, count: number): string {
  return `- (${count} ${section.newestLast ? 'older' : 'more'} in the journal file)`
}

/**
 * Stable digest of a rendered recall block.
 * @param text - the block text.
 * @returns a hex digest.
 */
export function digestRecall(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Whether a message is this plugin's recall message.
 * @param message - any user-role message.
 * @returns true for a `dsh-research` plugin source in `recall` form.
 */
export function isRecallMessage(message: UserMessage): boolean {
  return isPluginRecallMessage(message, RESEARCH_PLUGIN)
}

/**
 * The text of a recall message.
 * @param message - a message that satisfies {@link isRecallMessage}.
 * @returns the concatenated text blocks.
 */
export function recallText(message: UserMessage): string {
  return messageText(message)
}

/**
 * Build the recall message for one rendered block.
 * @param text - the block from {@link renderJournalRecall}.
 * @returns a user-role message sourced to this plugin in `recall` form.
 */
export function createRecallMessage(text: string): UserMessage {
  return createPluginRecallMessage(RESEARCH_PLUGIN, text)
}
