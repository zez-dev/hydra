/**
 * Stable hashes that decide what a resumed run may replay. A call's hash
 * covers every input that changes what the child would answer; the script's
 * hash covers the body verbatim.
 * @module @deepseek-ai/dsh-workflow/hash
 */

import { createHash } from 'node:crypto'

/** The `agent()` inputs that decide whether a journaled result still applies. */
export interface CallKeyInput {
  /** The child's prompt text. */
  readonly prompt: string
  /** The per-child provider override, when the call passed one. */
  readonly provider?: string | undefined
  /** The per-child model override, when the call passed one. */
  readonly model?: string | undefined
  /** The structured-output schema, when the call passed one. */
  readonly schema?: unknown
}

/**
 * Serialize a JSON value with object keys in sorted order, so two structurally
 * equal values always produce the same text. `undefined` members are dropped,
 * which is what makes an absent option and an explicit `undefined` one hash
 * alike.
 * @param value - the value to serialize.
 * @returns the canonical text.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    // Object keys are unique, so no two entries compare equal.
    .sort(([left], [right]) => (left < right ? -1 : 1))
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`).join(',')}}`
}

/**
 * Hash the text with the digest width the journal stores.
 * @param text - the text to hash.
 * @returns 16 lowercase hex characters.
 */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * Hash one `agent()` call's inputs. Two runs of an unchanged script produce
 * the same hash at the same ordinal; editing the prompt, the route or the
 * schema changes it, so the resumed run makes that call for real.
 * @param input - the call's prompt and options.
 * @returns the call's key hash.
 */
export function callKeyHash(input: CallKeyInput): string {
  return digest(canonical({
    prompt: input.prompt,
    provider: input.provider,
    model: input.model,
    schema: input.schema,
  }))
}

/**
 * Hash a workflow script body verbatim. Whitespace counts: a reformatted
 * script is a different script, and the journal reports the difference rather
 * than guessing that the change was cosmetic.
 * @param body - the script body.
 * @returns the script hash.
 */
export function scriptHash(body: string): string {
  return digest(body)
}
