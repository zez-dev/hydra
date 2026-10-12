/**
 * Human-facing `/compact` command over the backend-independent compaction seam.
 * @module @deepseek-ai/dsh-command-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'command-compact'
export const inject = ['commands', 'compaction']

const USAGE = 'Usage: /compact (no arguments)'

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown manual compaction error code: ${String(value)}`)
}
/* v8 ignore stop */

/** Convert expected capability failures into concise human-only outcomes. */
function expectedFailure(error: ManualCompactionError): CommandResult {
  switch (error.code) {
    case 'busy':
      return {
        kind: 'error',
        text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
      }
    case 'cancelled':
      return { kind: 'error', text: 'Compaction cancelled.' }
    case 'changed':
      return {
        kind: 'error',
        text: 'The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.',
      }
    case 'summary':
      return {
        kind: 'error',
        text: `Compaction could not produce a useful summary: ${summaryFailureReason(error)}${factsText(error.facts)}. `
          + 'The attempt is recorded in the session log.',
      }
    case 'commit':
      return {
        kind: 'error',
        text: 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
      }
    case 'persistence':
      return {
        kind: 'error',
        text: 'Compaction finished, but the session could not be saved.',
      }
    /* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */
    default: return assertNever(error.code)
  }
}

/**
 * Turn the backend's summary diagnostic into the reason a person can act on:
 * a checkpoint no smaller than the history it replaces, a summary cut at its
 * output cap, a summarization request the provider refused, or the
 * diagnostic itself.
 * @param error - the classified summary failure, with the backend error as its cause.
 * @returns one sentence fragment without a trailing period.
 */
function summaryFailureReason(error: ManualCompactionError): string {
  const detail = error.cause instanceof Error ? error.cause.message : error.message
  const tooBig = /\((\d+) estimated framed tokens >= (\d+)\)/u.exec(detail)
  if (tooBig !== null) {
    return `the checkpoint (${tooBig[1]} tokens) would not be smaller than the history it replaces (${tooBig[2]} tokens); `
      + 'condense again once there is more history'
  }
  if (detail.includes('truncated at the token cap')) {
    return 'the summary was cut at its output cap even after raising it to the window share and condensing smaller ranges; '
      + 'a model that thinks before it answers spends part of the cap on that, so raise summaryWindowRatio on '
      + 'dsh-compaction-basic or route summarization to a model that answers without thinking'
  }
  if (isProviderOverflow(error.cause)) {
    return 'the provider refused the summarization request as over its window, and three retries on smaller ranges '
      + 'were refused too, so the provider counts more tokens than the configured contextWindow allows; '
      + 'lower contextWindow for this model in settings to what the provider accepts'
  }
  return detail
}

/**
 * Render the engine's facts about a failure as one parenthesized clause, so a
 * pasted reason carries the numbers a maintainer needs.
 * @param facts - the engine's facts, or nothing.
 * @returns the clause with a leading space, or an empty string.
 */
function factsText(facts: ManualCompactionError['facts']): string {
  if (facts === undefined) return ''
  const entries = Object.entries(facts).map(([key, value]) => `${key} ${value}`)
  return entries.length === 0 ? '' : ` (${entries.join(', ')})`
}

/** Whether `error` or a failure it wraps as its cause is the provider refusing a request as over its window. */
function isProviderOverflow(error: unknown): boolean {
  for (let current = error; typeof current === 'object' && current !== null; current = (current as { cause?: unknown }).cause) {
    if ('code' in current && current.code === CONTEXT_WINDOW_EXCEEDED_CODE) return true
  }
  return false
}

/** Execute one argument-free manual compaction request. */
async function executeCompact(
  ctx: Context,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: USAGE }
  }
  try {
    const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: 'No compactable history yet.' }
    return {
      kind: 'success',
      text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
      sourceEventSeq: result.summarySeq,
    }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    throw error
  }
}

/**
 * Register `/compact` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the compaction seam.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeCompact(ctx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-compact'),
      name: 'compact',
      description: 'Compact older conversation history',
      handler,
    })
  }, 'command-compact lifecycle')
}
