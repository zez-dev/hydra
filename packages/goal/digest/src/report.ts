/**
 * Pure digest helpers: the daily-time grammar, local calendar math, journal
 * scanning, and the Markdown renderer.
 * @module
 */

import { localDateKey } from '@deepseek-ai/dsh-util-time'
import type { DailyTime, DailyTotals, DigestInput } from './types.ts'

/** Marker that opens the totals footer comment of a daily report. */
export const FOOTER_MARK = 'hydra-digest'

/** Text used for a section whose seam is absent. */
const NOT_MOUNTED = '_not mounted_'

/**
 * Parse a `HH:MM` local time.
 * @param text - the configured value.
 * @returns the hour and minute.
 * @throws when the text is not `HH:MM` within the day.
 */
export function parseDailyAt(text: string): DailyTime {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(text.trim())
  const hour = match === null ? NaN : Number(match[1])
  const minute = match === null ? NaN : Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    throw new Error(`digest: dailyAt must be HH:MM in local time, got ${JSON.stringify(text)}`)
  }
  return { hour, minute }
}

/**
 * Milliseconds from `now` to the next occurrence of a local time of day.
 * @param time - the target time.
 * @param now - the reference moment.
 * @returns a positive delay; a target equal to `now` counts as tomorrow.
 */
export function msUntil(time: DailyTime, now: Date): number {
  const target = new Date(now)
  target.setHours(time.hour, time.minute, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
}

/**
 * Whether an ISO-8601 timestamp falls on a local calendar date.
 * @param iso - the timestamp.
 * @param date - `YYYY-MM-DD`.
 * @returns true when the timestamp's local date equals `date`.
 */
export function isOnDate(iso: string, date: string): boolean {
  const parsed = new Date(iso)
  return !Number.isNaN(parsed.getTime()) && localDateKey(parsed) === date
}

/**
 * Breakthrough lines a research journal records on a date. The `## Breakthroughs`
 * section holds one bullet per entry, each starting with `[YYYY-MM-DD]`.
 * @param journal - the journal Markdown.
 * @param date - `YYYY-MM-DD`.
 * @returns the entry texts without their date prefix.
 */
export function breakthroughsOn(journal: string, date: string): string[] {
  const section = /^## Breakthroughs\s*$([\s\S]*?)(?=^## |(?![\s\S]))/mu.exec(journal)
  const body = section?.[1]
  if (body === undefined) return []
  const found: string[] = []
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^\s*[-*]\s*/u, '').trim()
    const dated = /^\[(?<day>\d{4}-\d{2}-\d{2})\]\s*(?<text>.*)$/u.exec(line)?.groups
    if (dated !== undefined) {
      if (dated['day'] === date && dated['text'] !== undefined && dated['text'].length > 0) found.push(dated['text'])
      continue
    }
    // Journal-store entries: `- [b-<id> <ISO time> <source>] text`.
    const stored = /^\[b-[0-9a-f]+ (?<at>\S+) (?:model|auto|human)\]\s*(?<text>.*)$/u.exec(line)?.groups
    if (stored?.['at'] !== undefined && stored['text'] !== undefined && isOnDate(stored['at'], date) && stored['text'].length > 0) {
      found.push(stored['text'])
    }
  }
  return found
}

/**
 * The totals footer of a day's report.
 * @param input - the gathered facts.
 * @returns the totals in footer form.
 */
export function dailyTotals(input: DigestInput): DailyTotals {
  return {
    date: input.date,
    ticketsOpened: input.tickets.openedToday,
    ticketsClosed: input.tickets.closedToday,
    checkpoints: input.checkpoints.length,
    breakthroughs: input.breakthroughs?.length ?? 0,
    memoryCandidates: input.memory?.candidates ?? 0,
    memoryApproved: input.memory?.approved ?? 0,
    spendTokens: input.spend?.dayTokens ?? null,
    cronRuns: input.cronRuns?.length ?? 0,
  }
}

/**
 * Render the machine-readable footer a daily report carries for the weekly
 * aggregation.
 * @param totals - the day's totals.
 * @returns one HTML comment line.
 */
export function renderFooter(totals: DailyTotals): string {
  return `<!-- ${FOOTER_MARK} ${JSON.stringify(totals)} -->`
}

/**
 * Render the day's Markdown report.
 * @param input - the gathered facts.
 * @returns the report text.
 */
export function renderDigest(input: DigestInput): string {
  const lines: string[] = [`# Hydra digest ${input.date}`, '']
  lines.push('## Goals')
  lines.push(...input.goals.length === 0
    ? ['_no live goals_']
    : input.goals.map(goal => `- ${goal.phase} (${goal.roundsStarted} rounds) ${goal.objective} — session ${goal.sessionId}`))
  lines.push('', '## Tickets')
  const counts = Object.entries(input.tickets.counts)
  lines.push(input.tickets.absent === true ? NOT_MOUNTED : counts.length === 0 ? '_no tickets_' : counts.map(([status, count]) => `${status}: ${count}`).join(', '))
  if (input.tickets.changedToday.length > 0) {
    lines.push('', 'Changed today:')
    lines.push(...input.tickets.changedToday.map(ticket => `- ${ticket.id} [${ticket.severity}] ${ticket.status} — ${ticket.title}`))
  }
  lines.push('', '## Checkpoints')
  lines.push(...input.checkpoints.length === 0
    ? ['_none today_']
    : input.checkpoints.map(entry => `- ${entry.commit.slice(0, 7)} ${entry.role} round ${entry.round}${entry.ticketId === undefined ? '' : ` ticket ${entry.ticketId}`}`))
  lines.push('', '## Memory')
  lines.push(input.memory === undefined ? NOT_MOUNTED : `candidates: ${input.memory.candidates}, approved: ${input.memory.approved}`)
  lines.push('', '## Spend')
  lines.push(input.spend === undefined ? NOT_MOUNTED : `${input.spend.dayTokens} tokens today`)
  lines.push('', '## Cron runs')
  lines.push(...input.cronRuns === undefined
    ? [NOT_MOUNTED]
    : input.cronRuns.length === 0 ? ['_none today_'] : input.cronRuns.map(run => `- ${run.name}: ${run.outcome}`))
  lines.push('', '## Research breakthroughs')
  lines.push(...input.breakthroughs === undefined
    ? ['_no research journal in this workspace_']
    : input.breakthroughs.length === 0 ? ['_none today_'] : input.breakthroughs.map(entry => `- ${entry}`))
  lines.push('', renderFooter(dailyTotals(input)), '')
  return lines.join('\n')
}
