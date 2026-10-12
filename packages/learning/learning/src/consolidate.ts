/**
 * `/learn consolidate`: group related memory entries and have the model
 * rewrite each group as the fewest current notes. The model names, for every
 * note it writes, the input ids that note replaces; only those inputs are
 * archived, so an input the answer does not account for stays as it was.
 * @module
 */

import { isWorkspaceTag, normalizeMemoryText, noteTerms, termSimilarity, visibleTags, workspaceTag } from '@deepseek-ai/dsh-memory'
import type { MemoryEntry, MemoryEntryKind, MemoryStore } from '@deepseek-ai/dsh-memory'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Stable system instruction for one consolidation request. */
export const CONSOLIDATE_SYSTEM_PROMPT = [
  'You tidy one group of related notes from an AI coding assistant\'s long-term memory into the fewest notes that keep every distinct fact.',
  'Each input note has an id, the date it was last stated, its kind, and its tags.',
  'Notes that say the same thing become one note in the clearest wording. When notes disagree, the note with the later date is current: keep what it says and drop the older statement.',
  'Every other fact in the input must appear in the output, and each note must still name its situation (the file, command, component, or problem it is about). Use only what the notes say; never add a fact.',
  'A note unrelated to the rest of the group is returned unchanged, with its own id in "from".',
  'Answer with a JSON array only. Each item is {"text": string, "kind": "fact" | "shortcut" | "preference", "tags": string[], "from": string[]}, where "from" lists the ids of every input note the item replaces. Text is one or two sentences.',
].join('\n')

/** One note the model wrote, with the input ids it replaces. */
export interface ConsolidatedNote {
  readonly text: string
  readonly kind: MemoryEntryKind
  readonly tags: readonly string[]
  /** Input ids this note replaces; never empty, never an id outside the group. */
  readonly from: readonly string[]
}

const KINDS: ReadonlySet<string> = new Set(['fact', 'shortcut', 'preference'])

/**
 * Read a consolidation answer: a JSON array, alone or inside a fence or
 * surrounding text. An item without text, or whose `from` names no id of the
 * group, is dropped; unknown ids are dropped from `from`; an unknown kind
 * reads as `fact`.
 * @param text - the model's answer.
 * @param ids - the group's entry ids.
 * @returns the notes, in answer order.
 */
export function parseConsolidation(text: string, ids: ReadonlySet<string>): ConsolidatedNote[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (_malformed) {
    // A malformed answer consolidates nothing; the group stays as it was.
    return []
  }
  const notes: ConsolidatedNote[] = []
  // Text running from a `[` to the last `]` that parses is an array.
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const body = typeof record['text'] === 'string' ? record['text'].trim() : ''
    const from = Array.isArray(record['from']) ? [...new Set(record['from'].filter((id): id is string => typeof id === 'string' && ids.has(id)))] : []
    if (body.length === 0 || from.length === 0) continue
    const kind = typeof record['kind'] === 'string' && KINDS.has(record['kind']) ? record['kind'] as MemoryEntryKind : 'fact'
    const tags = Array.isArray(record['tags']) ? record['tags'].filter((tag): tag is string => typeof tag === 'string') : []
    notes.push({ text: body, kind, tags, from })
  }
  return notes
}

/** How groups are formed. */
export interface GroupOptions {
  /** Note similarity at or above which a note joins a group's first note. */
  readonly threshold: number
  /** Most notes in one group. */
  readonly maxSize: number
  /** The session's workspace; with `all` unset, only its notes and notes without a workspace are grouped. */
  readonly workspace?: string
  /** Group every workspace's notes. */
  readonly all: boolean
}

/** Rarest words of a note whose other holders are candidates for its group. */
const GROUP_RARE_TERMS = 4

/**
 * Group related entries: each group is a first note and the not yet grouped
 * notes similar to it (sharing one of its four rarest words and reaching the
 * threshold), most similar first, up to `maxSize`. Groups of one are dropped.
 * @param entries - the approved and promoted entries.
 * @param options - threshold, size cap, and workspace scope.
 * @returns the groups, largest first, each oldest note first.
 */
export function planGroups(entries: readonly MemoryEntry[], options: GroupOptions): MemoryEntry[][] {
  const own = options.workspace === undefined ? undefined : workspaceTag(options.workspace)
  const pool = entries
    .filter((entry) => {
      const tag = entry.tags.find(isWorkspaceTag)
      return options.all || tag === undefined || tag === own
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const terms = pool.map(entry => noteTerms(entry.text))
  const holders = new Map<string, number[]>()
  for (const [index, set] of terms.entries()) {
    for (const term of set) holders.set(term, [...holders.get(term) ?? [], index])
  }
  const grouped = new Set<number>()
  const groups: MemoryEntry[][] = []
  for (const [index, set] of terms.entries()) {
    if (grouped.has(index)) continue
    const rare = [...set]
      .sort((a, b) => (holders.get(a)?.length ?? 0) - (holders.get(b)?.length ?? 0) || a.localeCompare(b))
      .slice(0, GROUP_RARE_TERMS)
    const scored = new Map<number, number>()
    for (const term of rare) {
      for (const other of holders.get(term) ?? []) {
        if (other === index || grouped.has(other) || scored.has(other)) continue
        const score = termSimilarity(set, terms[other] ?? new Set())
        if (score >= options.threshold) scored.set(other, score)
      }
    }
    const members = [...scored.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, options.maxSize - 1).map(([other]) => other)
    if (members.length === 0) continue
    for (const member of [index, ...members]) grouped.add(member)
    groups.push([index, ...members].sort((a, b) => a - b).flatMap(member => pool[member] ?? []))
  }
  return groups.sort((a, b) => b.length - a.length)
}

/**
 * The request text for one group: one line per note with its id, date, kind, and visible tags.
 * @param group - the group's entries.
 * @returns the user message text.
 */
export function renderGroup(group: readonly MemoryEntry[]): string {
  return [
    'Tidy these notes:',
    ...group.map((entry) => {
      const tags = visibleTags(entry.tags)
      return `- [${entry.id}] (${entry.updatedAt.slice(0, 10)}, ${entry.kind}${tags.length === 0 ? '' : `; ${tags.join(', ')}`}) ${entry.text}`
    }),
  ].join('\n')
}

/** What one `/learn consolidate` run did. */
export interface ConsolidationSummary {
  /** Groups this run sent to the model. */
  readonly groups: number
  /** Groups beyond the per-run cap, left for the next run. */
  readonly remaining: number
  /** Groups whose answer replaced notes. */
  consolidated: number
  /** Notes archived because an answer replaced them. */
  replaced: number
  /** Notes the answers wrote. */
  written: number
  /** Notes the answers returned unchanged or did not account for; they stay as they were. */
  kept: number
  /** Grouped notes without a workspace tag, saved before notes were tagged with their project. */
  untagged: number
  /** Groups whose request failed; their notes stay as they were. */
  readonly failed: { readonly group: number; readonly message: string }[]
}

/**
 * Consolidate each group: ask the model, archive the notes its answer
 * replaces, write the notes it returns (with the workspace tags of the notes
 * each one replaces), and link both ways through the entries' notes. A note
 * returned unchanged with its own id replaces nothing, and a note the answer
 * does not name in any `from` stays as it was. A failed request is recorded
 * and the run goes on; a cancelled one is rethrown.
 * @param store - the memory store.
 * @param groups - this run's groups.
 * @param remaining - groups left for the next run.
 * @param ask - sends one group's request and returns the answer text.
 * @param sessionId - the session the written notes are attributed to.
 * @param signal - cancellation; checked before each group.
 * @returns the run's totals.
 */
export async function runConsolidation(
  store: MemoryStore,
  groups: readonly (readonly MemoryEntry[])[],
  remaining: number,
  ask: (group: readonly MemoryEntry[]) => Promise<string>,
  sessionId: SessionId | undefined,
  signal: AbortSignal,
): Promise<ConsolidationSummary> {
  const summary: ConsolidationSummary = {
    groups: groups.length, remaining, consolidated: 0, replaced: 0, written: 0, kept: 0, untagged: 0, failed: [],
  }
  for (const [index, group] of groups.entries()) {
    signal.throwIfAborted()
    summary.untagged += group.filter(entry => !entry.tags.some(isWorkspaceTag)).length
    let answer: string
    try {
      answer = await ask(group)
    } catch (error) {
      if (signal.aborted) throw error
      summary.failed.push({ group: index + 1, message: error instanceof Error ? error.message : String(error) })
      summary.kept += group.length
      continue
    }
    const unchanged = (note: ConsolidatedNote): boolean => note.from.length === 1
      && group.some(entry => entry.id === note.from[0] && entry.text === normalizeMemoryText(note.text))
    const changes = parseConsolidation(answer, new Set(group.map(entry => entry.id))).filter(note => !unchanged(note))
    const replaced = group.filter(entry => changes.some(note => note.from.includes(entry.id)))
    summary.kept += group.length - replaced.length
    if (changes.length === 0) continue
    // Archive first, so storing a written note never restates one it replaces.
    for (const entry of replaced) await store.setStatus(entry.id, 'archived')
    const written: { readonly id: string; readonly from: readonly string[] }[] = []
    for (const note of changes) {
      const projects = replaced.filter(entry => note.from.includes(entry.id)).flatMap(entry => entry.tags.filter(isWorkspaceTag))
      const entry = await store.add({ text: note.text, kind: note.kind, tags: [...new Set([...note.tags, ...projects])] }, 'approved', sessionId)
      await store.update(entry.id, { note: `consolidated from ${note.from.join(', ')}` })
      written.push({ id: entry.id, from: note.from })
    }
    for (const entry of replaced) {
      await store.update(entry.id, { note: `consolidated into ${written.filter(item => item.from.includes(entry.id)).map(item => item.id).join(', ')}` })
    }
    summary.consolidated += 1
    summary.replaced += replaced.length
    summary.written += changes.length
  }
  return summary
}

/**
 * Render a run's totals for the command result.
 * @param summary - the totals.
 * @param all - whether the run covered every workspace.
 * @returns a few lines.
 */
export function renderConsolidation(summary: ConsolidationSummary, all: boolean): string {
  if (summary.groups === 0) {
    return all
      ? 'Nothing to consolidate: no related notes in memory.'
      : 'Nothing to consolidate: no related notes in this project. /learn consolidate --all looks across every project.'
  }
  const failed = summary.failed.slice(0, 5).map(item => `group ${item.group} (${item.message})`).join(', ')
  return [
    `Consolidated ${summary.consolidated} of ${summary.groups} group(s): ${summary.replaced} note(s) became ${summary.written}; ${summary.kept} kept as they were.`,
    ...summary.untagged === 0 ? [] : [`${summary.untagged} grouped note(s) have no project tag (saved before notes were tagged); run this from the project they belong to.`],
    ...summary.failed.length === 0 ? [] : [`Failed ${summary.failed.length} group(s): ${failed}${summary.failed.length > 5 ? ', ...' : ''}; their notes are unchanged.`],
    ...summary.remaining === 0 ? [] : [`${summary.remaining} more group(s) remain; run /learn consolidate again to continue.`],
    'Replaced notes are archived: /memory archived lists them, /memory restore <id> brings one back.',
  ].join('\n')
}
