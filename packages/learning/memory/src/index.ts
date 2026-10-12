/**
 * Durable learned memory. The plugin opens the `learning_memory` storage
 * domain, publishes `ctx.memory`, retrieves the approved entries related to
 * each user request into that step as one digest-stable `user/message`, and registers the human
 * `/memory` command; the model-facing `memory` tool ships as the `./tools`
 * entry. Named exports preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { messageText } from '@deepseek-ai/dsh-llm'
import { DomainMemoryStore, memoryDomainSpec } from './store.ts'
import { createRecallMessage, digestRecall, isRecallMessage, recallText, renderRecallDetailed } from './recall.ts'
import { rankEntries } from './rank.ts'
import { visibleTags } from './workspace.ts'
import type { MemoryCurationPolicy, MemoryEntry, MemoryEntryId, MemoryEntryKind, MemoryEntryStatus, MemoryStore } from './types.ts'

export type * from './types.ts'
export { memoryDomainSpec, normalizeMemoryText } from './store.ts'
export { createRecallMessage, digestRecall, isRecallMessage, MEMORY_PLUGIN, recallText, renderRecall, renderRecallDetailed } from './recall.ts'
export { rankEntries } from './rank.ts'
export type { RankOptions } from './rank.ts'
export { isWorkspaceTag, visibleTags, workspaceTag } from './workspace.ts'
export { jaccardSimilarity, planCuration, planSuggestions, slugifySkillName } from './curator.ts'
export { isSameNote, normalizeForSimilarity, noteSimilarity, noteTerms, termSimilarity } from './similarity.ts'
export type { CurationAction, CurationMerge, CurationPlan, SuggestionPlan } from './curator.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable learned memory; provided by `dsh-memory`. */
    memory: MemoryStore
  }
}

export const name = 'memory'
export const inject = ['storageDomain', 'commands', 'agents']

/** Entries retrieved per request when `recallLimit` is not configured. */
const DEFAULT_RECALL_LIMIT = 5
/** Distinct words of the current work a retrieved note must share. */
const DEFAULT_MIN_MATCHED_TERMS = 2
/** Fraction of the best retrieved note's score below which a note is left out. */
const DEFAULT_SCORE_FLOOR = 0.5
/** Fraction of a note's own words that, once matched, retrieves it with fewer shared words. */
const DEFAULT_NOTE_COVERAGE = 0.3
/** Note similarity at or above which two entries are the same note. */
const DEFAULT_DUPLICATE_THRESHOLD = 0.7
/** Characters of the latest request and of the latest reply a recall without new work matches against. */
const CONTEXT_CHARS = 2000
/** Kinds recalled with every request when `alwaysRecallKinds` is not configured. */
const DEFAULT_ALWAYS_RECALL_KINDS: readonly MemoryEntryKind[] = ['preference']

/** Memory plugin configuration. */
export interface Config {
  /** Byte cap on the `<retrieved_memory>` block recalled into a request; trailing entries are dropped. */
  maxRecallBytes: number
  /** The most entries retrieved for one request by relevance to its text (default 5). */
  recallLimit?: number
  /** Entry kinds recalled with every request whatever its text, ahead of the retrieved entries (default `['preference']`). */
  alwaysRecallKinds?: MemoryEntryKind[]
  /** Distinct words of the current work a retrieved entry must share, capped at the work's own count (default 2). */
  recallMinMatchedTerms?: number
  /** Fraction of the best retrieved entry's score below which an entry is left out (default 0.5). */
  recallScoreFloor?: number
  /**
   * Fraction of an entry's own words that, once the work matches them, retrieves it with fewer than
   * `recallMinMatchedTerms` shared words: a short note about the word stays, a long one that mentions it does not (default 0.3).
   */
  recallNoteCoverage?: number
  /** Days without recall or use before an approved entry turns `stale`; omit to never age. */
  staleAfterDays?: number
  /** Days without recall or use before an entry turns `archived`; omit to never archive. */
  archiveAfterDays?: number
  /**
   * Note similarity (`noteSimilarity`) at or above which two entries are the same note: storing one updates the
   * stored entry to the new wording, and curation merges a group into its newest entry (default 0.7).
   */
  duplicateThreshold?: number
  /** Similarity at or above which recalled entries cluster into a skill suggestion; omit to never suggest. */
  skillSuggestThreshold?: number
  /** Smallest cluster that becomes a skill suggestion (default 3). */
  skillSuggestMinEntries?: number
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  maxRecallBytes: z.natural().min(1).required(),
  recallLimit: z.natural().min(1).default(DEFAULT_RECALL_LIMIT),
  alwaysRecallKinds: z.array(z.union(['fact', 'shortcut', 'preference'] as const)).default([...DEFAULT_ALWAYS_RECALL_KINDS]),
  recallMinMatchedTerms: z.natural().min(1).default(DEFAULT_MIN_MATCHED_TERMS),
  recallScoreFloor: z.number().min(0).max(1).default(DEFAULT_SCORE_FLOOR),
  recallNoteCoverage: z.number().min(0).max(1).default(DEFAULT_NOTE_COVERAGE),
  staleAfterDays: z.natural().min(1),
  archiveAfterDays: z.natural().min(1),
  duplicateThreshold: z.number().min(0).max(1).default(DEFAULT_DUPLICATE_THRESHOLD),
  skillSuggestThreshold: z.number().min(0).max(1),
  skillSuggestMinEntries: z.natural().min(2).default(3),
})

const STATUSES = ['candidate', 'approved', 'promoted', 'rejected', 'stale', 'archived'] as const

/** Once per process day. */
const CURATION_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the curation policy from config: absent when no window is set.
 * @param config - deployment configuration.
 * @returns the policy, or `undefined` when curation is off.
 */
function resolvePolicy(config: Config): MemoryCurationPolicy | undefined {
  const off = config.staleAfterDays === undefined && config.archiveAfterDays === undefined && config.skillSuggestThreshold === undefined
  if (off) return undefined
  return {
    ...config.staleAfterDays === undefined ? {} : { staleAfterDays: config.staleAfterDays },
    ...config.archiveAfterDays === undefined ? {} : { archiveAfterDays: config.archiveAfterDays },
    duplicateThreshold: config.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD,
    ...config.skillSuggestThreshold === undefined ? {} : { skillSuggestThreshold: config.skillSuggestThreshold },
    skillSuggestMinEntries: config.skillSuggestMinEntries ?? 3,
  }
}

/**
 * What the agent's model-visible surface holds for recall: the digest of the
 * recall block in view, and otherwise the latest request and reply, which a
 * step without new work matches entries against.
 * @param agent - the stepping agent.
 * @returns the visible digest when a recall is in view; the context text when none is.
 */
function recallHistory(agent: Agent): { visibleDigest?: string; context: string } {
  let request: string | undefined
  let reply: string | undefined
  for (const seq of [...agent.session.surface.nodes].reverse()) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(seq)
    if (event?.type === 'user/message') {
      if (isRecallMessage(event.data)) return { visibleDigest: digestRecall(recallText(event.data)), context: '' }
      if (request === undefined && event.data.source.kind === 'user') request = messageText(event.data)
    } else if (event?.type === 'assistant/message' && reply === undefined) {
      reply = messageText(event.data.message)
    }
  }
  return { context: [request, reply].map(text => (text ?? '').slice(-CONTEXT_CHARS)).join('\n').trim() }
}

/**
 * The text of the messages a step admits that start work: the user's own,
 * a goal round's, a webhook's, any source but a plugin's. Retrieval ranks
 * entries against it.
 * @param messages - the step's messages.
 * @returns their text blocks joined by newlines; empty when the step carries no such message.
 */
function workText(messages: readonly UserMessage[]): string {
  return messages
    .filter(message => message.source.kind !== 'plugin')
    .map(message => messageText(message))
    .join('\n')
    .trim()
}

/**
 * Register recall injection: on a step that starts work (the user's request,
 * a goal round, a webhook), and on any step while no recall block is in view
 * (as after a compaction condensed it), the approved entries of the
 * always-recalled kinds plus the ones most related to the work are added as
 * one recall message, unless the visible recall already carries the same
 * block. Related entries share at least `recallMinMatchedTerms` words with the
 * work or have `recallNoteCoverage` of their own words matched, score within
 * `recallScoreFloor` of the best, and rank the session's own workspace first.
 * @param ctx - plugin context.
 * @param store - the memory store.
 * @param config - the byte cap, retrieval limit, and always-recalled kinds.
 */
function installRecall(
  ctx: Context,
  store: MemoryStore,
  config: Pick<Config, 'maxRecallBytes' | 'recallLimit' | 'alwaysRecallKinds' | 'recallMinMatchedTerms' | 'recallScoreFloor' | 'recallNoteCoverage'>,
): void {
  const always = new Set(config.alwaysRecallKinds ?? DEFAULT_ALWAYS_RECALL_KINDS)
  const limit = config.recallLimit ?? DEFAULT_RECALL_LIMIT
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const pending = decision.messages.find(isRecallMessage)
    const withoutPending = (): PreStepDecision => (pending === undefined
      ? decision
      : { ...decision, messages: decision.messages.filter(message => message !== pending) })
    const recalled = store.recalled()
    if (recalled.length === 0) return withoutPending()
    const work = workText(decision.messages)
    const view = recallHistory(agent)
    if (work.length === 0 && view.visibleDigest !== undefined) return withoutPending()
    const query = work.length > 0 ? work : view.context
    if (query.length === 0) return withoutPending()
    const cwd = agent.session.header.cwd
    const selected = [
      ...recalled.filter(entry => always.has(entry.kind)),
      ...rankEntries(recalled.filter(entry => !always.has(entry.kind)), query, limit, {
        ...cwd === undefined ? {} : { workspace: cwd },
        minMatchedTerms: config.recallMinMatchedTerms ?? DEFAULT_MIN_MATCHED_TERMS,
        minCoverage: config.recallNoteCoverage ?? DEFAULT_NOTE_COVERAGE,
        scoreFloor: config.recallScoreFloor ?? DEFAULT_SCORE_FLOOR,
      }),
    ]
    const { text, ids } = renderRecallDetailed(selected, config.maxRecallBytes)
    if (text.length === 0) return withoutPending()
    const digest = digestRecall(text)
    if (view.visibleDigest === digest) return withoutPending()
    if (pending !== undefined && digestRecall(recallText(pending)) === digest) return decision
    const recall = createRecallMessage(text)
    const recalledAt = new Date().toISOString()
    for (const id of ids) await store.touch(id, { lastRecalledAt: recalledAt })
    return {
      ...decision,
      messages: pending === undefined
        ? [...decision.messages, recall]
        : decision.messages.map(message => message === pending ? recall : message),
    }
  })
}

const USAGE = 'Usage: /memory [forget <id> | restore <id> | curate | archived | suggestions]'

/**
 * Render entries for the command result.
 * @param entries - entries to list.
 * @returns one line per entry grouped by status.
 */
function renderEntries(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return 'No memory entries.'
  const lines: string[] = []
  for (const status of STATUSES) {
    const group = entries.filter(entry => entry.status === status)
    if (group.length === 0) continue
    lines.push(`${status} (${group.length}):`)
    for (const entry of group) {
      const tags = visibleTags(entry.tags)
      lines.push(`  ${entry.id} [${entry.kind}${tags.length > 0 ? `; ${tags.join(', ')}` : ''}] ${entry.text}`)
    }
  }
  return lines.join('\n')
}

/**
 * Handle one `/memory` invocation.
 * @param store - the memory store.
 * @param invocation - the parsed command input.
 * @returns the command result.
 */
async function executeMemoryCommand(store: MemoryStore, invocation: CommandInvocation): Promise<CommandResult> {
  const words = invocation.rawInput.trim().split(/\s+/u).filter(word => word.length > 0)
  if (words.length === 0) return { kind: 'success', text: renderEntries(store.list().filter(entry => entry.status !== 'archived')) }
  const [verb, id] = words
  if (verb === 'forget' && id !== undefined) {
    const deleted = await store.forget(brandString<MemoryEntryId>(id))
    return deleted ? { kind: 'success', text: `Forgot ${id}.` } : { kind: 'error', text: `No memory entry ${id}.` }
  }
  if (verb === 'restore' && id !== undefined) {
    const entry = store.get(brandString<MemoryEntryId>(id))
    if (entry === undefined) return { kind: 'error', text: `No memory entry ${id}.` }
    if (entry.status !== 'archived') return { kind: 'error', text: `Memory entry ${id} is ${entry.status}, not archived.` }
    await store.setStatus(entry.id, 'approved')
    return { kind: 'success', text: `Restored ${id}; it is recalled again.` }
  }
  if (verb === 'archived') {
    const archived = store.list({ status: 'archived' })
    if (archived.length === 0) return { kind: 'success', text: 'No archived memory entries.' }
    return {
      kind: 'success',
      text: archived.map(entry => `  ${entry.id} [${entry.kind}] ${entry.text}${entry.note === undefined ? '' : ` (${entry.note})`}`).join('\n'),
    }
  }
  if (verb === 'suggestions') {
    const proposed = store.suggestions({ status: 'proposed' })
    if (proposed.length === 0) return { kind: 'success', text: 'No skill suggestions; run /memory curate to look for clusters.' }
    return {
      kind: 'success',
      text: [
        `${proposed.length} skill suggestion(s):`,
        ...proposed.map(suggestion => `  ${suggestion.id} \`${suggestion.name}\` (${suggestion.entryIds.length} entries: ${suggestion.entryIds.join(', ')})`),
        'Accept with /learn accept <id> [name], dismiss with /learn dismiss <id>.',
      ].join('\n'),
    }
  }
  if (verb === 'curate') {
    try {
      const report = await store.curate()
      return { kind: 'success', text: `Curated memory: ${report.stale} stale, ${report.archived} archived, merged ${report.merged}, suggested ${report.suggested} skill(s).` }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }
  return { kind: 'error', text: USAGE }
}

/**
 * Open the domain, publish `ctx.memory`, and install recall and the command.
 * @param ctx - plugin context carrying `storageDomain`, `commands`, and `agents`.
 * @param config - deployment configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const policy = resolvePolicy(config)
  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  ctx.effect(() => () => domain.close(), 'memory.domainClose')
  const store: MemoryStore = new DomainMemoryStore(domain, policy, config.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD)
  ctx.provide('memory', store)
  installRecall(ctx, store, config)
  ctx.effect(() => ctx.commands.register({
    name: 'memory',
    description: 'List learned memory entries, forget one, curate, show archived entries, or list skill suggestions',
    input: { hint: '[forget <id> | curate | archived | suggestions]' },
    handler: invocation => executeMemoryCommand(store, invocation),
  }))
  if (policy !== undefined) installCurator(ctx, store)
}

/**
 * Run the curator at activation and once per process day; the timer is
 * disposed with the plugin.
 * @param ctx - plugin context.
 * @param store - the memory store.
 */
function installCurator(ctx: Context, store: MemoryStore): void {
  const run = (): void => {
    void store.curate().catch((error: unknown) => {
      ctx.logger.warn(`memory: curation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  ctx.effect(() => {
    run()
    const timer = setInterval(run, CURATION_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, 'memory.curator')
}

/** Statuses accepted by consumers that change review state. */
export const MEMORY_STATUSES: readonly MemoryEntryStatus[] = STATUSES
