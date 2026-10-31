/**
 * Model-facing read, read_image, write, and edit tools over `ctx.fs`. This package owns schemas, validation,
 * read windows, formatting, and observation events, never a concrete provider. An optional
 * event policy supplies mutation guards; without one the tools use unconditional provider calls.
 * @module @deepseek-ai/dsh-tool-fs
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-user-approval'
import { applyReadTool, READ_LIMIT, STREAM_MIN_SIZE, type ReadWindowShare } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyEditTool } from './edit.ts'
import { applyReadImageTool } from './read-image.ts'
import { READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from './read-render.ts'
import { FsSandboxController } from './sandbox.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs'

/** Services required by the filesystem tool suite. */
export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Register `read` and its guidance. Defaults to true. */
  read?: boolean
  /** Register `read_image` while an attachment store is mounted. Defaults to true. */
  readImage?: boolean
  /** Register `write` and its guidance. Defaults to true. */
  write?: boolean
  /** Register `edit` and its guidance. Defaults to true. */
  edit?: boolean
  /** Default and maximum number of lines returned by one `read` call. */
  readLimit?: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength?: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes?: number
  /** Files at or above this size stream instead of loading whole into memory. */
  readStreamMinSize?: number
  /**
   * Fraction, greater than 0 and at most 1, of the routed model's context window left after
   * `readContextReserveTokens` that one complete `read` result may fill, converted to bytes with
   * `readBytesPerToken`. Set it together with `readBytesPerToken`; unset, `readMaxBytes` alone
   * caps a read.
   */
  readContextFraction?: number
  /**
   * Bytes of `read` result assumed per token of the routed model, a positive number used only to
   * convert `readContextFraction` into bytes. Set it together with `readContextFraction`.
   */
  readBytesPerToken?: number
  /**
   * Tokens of the routed context window, a non-negative integer, kept for the rest of the request
   * before `readContextFraction` applies; set it only with the share fields. Defaults to 0.
   */
  readContextReserveTokens?: number
  /**
   * Maximum bytes returned for the selected lines of one `read` call whose routed context window
   * is known, in place of `readMaxBytes`; a call with no known window keeps `readMaxBytes`. Set it
   * only with the share fields. Defaults to `readMaxBytes`.
   */
  readContextMaxBytes?: number
}

export const Config: z<Config> = z.object({
  read: z.boolean().default(true),
  readImage: z.boolean().default(true),
  write: z.boolean().default(true),
  edit: z.boolean().default(true),
  readLimit: z.number().default(READ_LIMIT),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
  readStreamMinSize: z.number().default(STREAM_MIN_SIZE),
  readContextFraction: z.number(),
  readBytesPerToken: z.number(),
  readContextReserveTokens: z.number(),
  readContextMaxBytes: z.number(),
})

/** The window-share fields, which have no schemastery defaults. */
type WindowShareKey = 'readContextFraction' | 'readBytesPerToken' | 'readContextReserveTokens' | 'readContextMaxBytes'

/** Configuration after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, WindowShareKey>> & Pick<Config, WindowShareKey>

/** Every read cap counts lines/chars/bytes — a positive integer, or windowing arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs: ${name} must be a positive integer`)
  }
}

/**
 * Validate the window-share fields: the fraction and bytes-per-token together or neither, a
 * fraction greater than 0 and at most 1, a positive finite bytes-per-token, an optional
 * non-negative integer reserve that defaults to 0, and an optional positive integer byte cap that
 * defaults to `readMaxBytes`.
 * @param config - the resolved plugin config.
 * @returns the share, or `undefined` when no share field is set.
 */
function resolveWindowShare(config: ResolvedConfig): ReadWindowShare | undefined {
  const {
    readContextFraction: fraction,
    readBytesPerToken: bytesPerToken,
    readContextReserveTokens: reserveTokens,
    readContextMaxBytes: maxBytes,
  } = config
  if (fraction === undefined && bytesPerToken === undefined) {
    if (reserveTokens !== undefined) {
      throw new Error('tool-fs: readContextReserveTokens requires readContextFraction and readBytesPerToken')
    }
    if (maxBytes !== undefined) {
      throw new Error('tool-fs: readContextMaxBytes requires readContextFraction and readBytesPerToken')
    }
    return undefined
  }
  if (fraction === undefined || bytesPerToken === undefined) {
    throw new Error('tool-fs: readContextFraction and readBytesPerToken must be set together')
  }
  if (!(fraction > 0 && fraction <= 1)) {
    throw new Error('tool-fs: readContextFraction must be greater than 0 and at most 1')
  }
  if (!(Number.isFinite(bytesPerToken) && bytesPerToken > 0)) {
    throw new Error('tool-fs: readBytesPerToken must be a positive finite number')
  }
  if (reserveTokens !== undefined && !(Number.isInteger(reserveTokens) && reserveTokens >= 0)) {
    throw new Error('tool-fs: readContextReserveTokens must be a non-negative integer')
  }
  if (maxBytes !== undefined) assertPositiveInteger('readContextMaxBytes', maxBytes)
  return { fraction, bytesPerToken, reserveTokens: reserveTokens ?? 0, maxBytes: maxBytes ?? config.readMaxBytes }
}

/** Register the selected filesystem tools; `read_image` additionally requires a mounted attachment store. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('readLimit', resolved.readLimit)
  assertPositiveInteger('readMaxLineLength', resolved.readMaxLineLength)
  assertPositiveInteger('readMaxBytes', resolved.readMaxBytes)
  assertPositiveInteger('readStreamMinSize', resolved.readStreamMinSize)
  const windowShare = resolveWindowShare(resolved)
  if (resolved.read) {
    applyReadTool(ctx, {
      limit: resolved.readLimit,
      maxLineLength: resolved.readMaxLineLength,
      maxBytes: resolved.readMaxBytes,
      streamMinSize: resolved.readStreamMinSize,
      ...windowShare === undefined ? {} : { windowShare },
    })
  }
  // read_image is composition-conditional: without a mounted attachment store
  // the deployment cannot durably commit image bytes, so the tool never
  // registers; the execute body keeps a defensive re-check for direct callers.
  if (resolved.readImage) {
    ctx.inject(['attachments'], (imageCtx) => {
      applyReadImageTool(imageCtx)
    })
  }
  // One escalation API shared by both mutating tools: advertisement gating,
  // per-call policy resolution, and denial-marker mapping, all keyed off whether
  // the mounted ctx.fs confines (ctx.fs.sandboxMode).
  if (resolved.write || resolved.edit) {
    const sandbox = new FsSandboxController(ctx)
    if (resolved.write) applyWriteTool(ctx, sandbox)
    if (resolved.edit) applyEditTool(ctx, sandbox)
  }
}
