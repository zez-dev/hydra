/**
 * Opt-in browser memory measurement for large Session transcripts.
 *
 * A reported symptom drives this lane: opening a big Session in a Chromium
 * browser raised a JavaScript out-of-memory error. The Web history page is
 * bounded by message count rather than bytes, the Client event store never
 * evicts, and the chat list renders every node, so the failure could come
 * from wire bytes, retained JSON, React and DOM nodes, or the turn-outline
 * projection.
 *
 * Each case boots its own scaffold so exactly one seeded Session exists,
 * opens it in a fresh page, waits for the newest turn to render, collects
 * garbage, and samples the renderer's exact heap through CDP. Sweeping one
 * dimension at a time attributes growth to a component instead of a guess.
 */
import { basename, dirname } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole } from '../tests/scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from '../tests/support.ts'

/** One Session's generated dimensions; each case varies one of them from {@link BASE_SHAPE}. */
interface SessionShape {
  /** Assistant replies, each preceded by its own user message and turn. */
  readonly messages: number
  /** Tool calls and their results inside each assistant step. */
  readonly toolResultsPerMessage: number
  /** Bytes of text in one tool result, before JSON escaping. */
  readonly toolResultBytes: number
  /** Bytes of assembled assistant text in one reply. */
  readonly assistantTextBytes: number
  /** Token records embedded in one reply's settled stream. */
  readonly streamChunks: number
}

/** The shape every sweep starts from: a transcript the Client loads in one page of history. */
const BASE_SHAPE: SessionShape = {
  messages: 50,
  toolResultsPerMessage: 2,
  toolResultBytes: 2_000,
  assistantTextBytes: 1_000,
  streamChunks: 200,
}

/** Inline ceiling of `dsh-spill-policy` in `dsh-base`: a real tool result reaches this before it spills. */
const SPILL_INLINE_BYTES = 45_000

/** Wall-clock budget for one case: scaffold boot, seed, open, settle, sample. */
const CASE_TIMEOUT_MS = 600_000

/** Heap a case may retain before this lane calls it a product defect rather than a measurement. */
const HEAP_BUDGET_BYTES = 1_500_000_000

/** One measured case. */
interface Measurement {
  readonly label: string
  readonly shape: SessionShape
  /** Bytes of the seeded log. */
  readonly logBytes: number
  /** Renderer heap after the transcript settled and garbage was collected. */
  readonly heapBytes: number
  /** Elements the unvirtualized transcript mounted. */
  readonly domNodes: number
}

const measurements: Measurement[] = []

/**
 * Build one settled stream record carrying `count` token texts, the shape a
 * real reply embeds in its `assistant/message`.
 * @param count - token records to emit.
 * @param time - stream start time.
 * @returns the reasoning-chunks record.
 */
function streamChunkRecord(count: number, time: number): Record<string, unknown> {
  return {
    type: 'reasoning-chunks',
    time0: time,
    index: 0,
    dt: Array.from({ length: count }, () => 0),
    texts: Array.from({ length: count }, (_, index) => ` token${String(index)}`),
  }
}

/**
 * Generate a tokenized Session log of the requested shape, ending on a closed
 * turn as `seedSession` requires.
 * @param shape - the dimensions to generate.
 * @returns the seed fixture text.
 */
function seedLog(shape: SessionShape): string {
  const time = 1784974100000
  const lines: string[] = [JSON.stringify({
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: time, cwd: '{{cwd}}/workspace', isSeeded: false, delegationDepth: 0,
  })]
  let seq = 0
  const at = (event: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ ...event, seq, time: time + seq }))
    seq += 1
  }
  const filler = (bytes: number): string => 'x'.repeat(Math.max(bytes, 1))
  for (let turn = 1; turn <= shape.messages; turn++) {
    at({ type: 'turn/start', data: { turn, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'seed' } } } })
    at({ type: 'step/start', data: { turn, step: 1 } })
    at({
      type: 'user/message',
      data: {
        id: `00000000-0000-4000-9000-${String(turn).padStart(12, '0')}`,
        role: 'user',
        content: [{ type: 'text', text: `Turn ${String(turn)} request. ${filler(200)}` }],
        source: { kind: 'user', rpcId: 'seed' },
      },
      surfaceOp: 'append',
    })
    at({
      type: 'request/header',
      data: { header: { config: { provider: 'stress', model: 'stress' } }, reason: turn === 1 ? 'initial' : 'change' },
    })
    const callIds = Array.from(
      { length: shape.toolResultsPerMessage },
      (_, index) => `call_${String(turn)}_${String(index)}`,
    )
    at({
      type: 'assistant/message',
      data: {
        turn,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `Reply ${String(turn)}. ${filler(shape.assistantTextBytes)}` },
            ...callIds.map(callId => ({
              type: 'tool-call', id: callId, name: 'bash',
              arguments: JSON.stringify({ command: 'echo ok', description: 'stress call' }),
            })),
          ],
          source: { kind: 'model', provider: 'stress', model: 'stress' },
          id: `00000000-0000-4000-8000-${String(turn).padStart(12, '0')}`,
        },
        usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, reasoningTokens: 0 },
        stream: [streamChunkRecord(shape.streamChunks, time + seq)],
      },
      surfaceOp: 'append',
    })
    for (const callId of callIds) {
      at({
        type: 'tool/call',
        data: {
          turn, step: 1, callId, name: 'bash',
          arguments: JSON.stringify({ command: 'echo ok', description: 'stress call' }),
        },
      })
      const resultSeq = seq
      at({
        type: 'tool/result',
        data: {
          turn,
          step: 1,
          message: {
            source: { kind: 'tool', callId },
            content: [{
              type: 'tool-result', toolCallId: callId,
              content: [{ type: 'text', text: filler(shape.toolResultBytes) }], isError: false,
            }],
            role: 'user',
            id: `00000000-0000-4000-7000-${String(resultSeq).padStart(12, '0')}`,
          },
        },
        sourceEventSeqs: [resultSeq - 1],
        surfaceOp: 'append',
      })
    }
    at({ type: 'step/end', data: { turn, step: 1 } })
    at({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return lines.join('\n')
}

/**
 * Boot a scaffold holding exactly this shape, open it in the browser, and
 * measure what the renderer retains once the newest turn is on screen.
 * @param label - case name for the report.
 * @param shape - dimensions to seed.
 * @returns the measurement.
 */
async function measure(label: string, shape: SessionShape, olderPages = 0): Promise<Measurement> {
  const scaffold = await launchWebScaffold()
  const browser = await chromium.launch()
  try {
    const text = seedLog(shape)
    await seedSession(scaffold, text, `stress-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`)
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 60_000 })
    await connectFreshWorkspace(page, dirname(scaffold.workspaceCwd), basename(scaffold.workspaceCwd))
    // A seeded Session is not attached to the Workspace entity, so the sidebar
    // files it under the collapsed Ungrouped group.
    const ungrouped = page.locator('[role="treeitem"]').filter({ hasText: 'Ungrouped' }).first()
    await ungrouped.waitFor({ timeout: 30_000 })
    if (await ungrouped.getAttribute('aria-expanded') === 'false') {
      await ungrouped.click()
      await page.waitForTimeout(1_000)
    }
    await page.locator('[role="treeitem"]').last().click()
    // The transcript is measurable only once its newest turn is on screen; a
    // sample taken before that reports an empty view, not a big Session.
    const transcript = page.locator('[class*="centerCol"]')
    await transcript.getByText(`Reply ${String(shape.messages)}.`, { exact: false })
      .first().waitFor({ timeout: 300_000 })
    // Settled when the mounted element count stops moving; a fixed sleep would
    // truncate a large case or waste a small one.
    let previous = -1
    let stable = 0
    let nodes = 0
    for (let poll = 0; poll < 240 && stable < 3; poll++) {
      await page.waitForTimeout(500)
      nodes = await transcript.evaluate(node => node.querySelectorAll('*').length)
      stable = nodes === previous ? stable + 1 : 0
      previous = nodes
    }
    // Older history loads from the transcript's explicit Load earlier control,
    // not from scrolling; the Client store never evicts, so each click measures
    // what one more page of history retains.
    for (let pass = 0; pass < olderPages; pass++) {
      const button = page.getByRole('button', { name: 'Load earlier' })
      if (await button.count() === 0) break
      const before = nodes
      await button.first().click()
      for (let poll = 0; poll < 240; poll++) {
        await page.waitForTimeout(500)
        nodes = await transcript.evaluate(node => node.querySelectorAll('*').length)
        if (nodes > before) break
      }
      let settle = -1
      for (let poll = 0; poll < 240 && nodes !== settle; poll++) {
        settle = nodes
        await page.waitForTimeout(500)
        nodes = await transcript.evaluate(node => node.querySelectorAll('*').length)
      }
      const sample = await page.context().newCDPSession(page)
      await sample.send('HeapProfiler.enable')
      await sample.send('HeapProfiler.collectGarbage')
      const passUsage = await sample.send('Runtime.getHeapUsage') as { usedSize: number }
      await sample.detach()
      process.stdout.write(
        `SCROLL ${label} page ${String(pass + 2)}: heap `
        + `${(passUsage.usedSize / 1024 / 1024).toFixed(0)} MB, nodes ${String(nodes)}\n`,
      )
    }
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    await cdp.send('HeapProfiler.collectGarbage')
    const usage = await cdp.send('Runtime.getHeapUsage') as { usedSize: number }
    await cdp.detach()
    expect(tripwire.pageErrors.join('\n')).not.toMatch(/out of memory|heap/i)
    const row: Measurement = {
      label, shape, logBytes: Buffer.byteLength(text), heapBytes: usage.usedSize, domNodes: nodes,
    }
    measurements.push(row)
    process.stdout.write(
      `CASE ${label}: log ${(row.logBytes / 1024 / 1024).toFixed(1)} MB, `
      + `heap ${(row.heapBytes / 1024 / 1024).toFixed(0)} MB, nodes ${String(row.domNodes)}\n`,
    )
    return row
  } finally {
    await browser.close()
    await scaffold.close()
  }
}

/**
 * Render the collected measurements as a table for the findings record.
 * @param rows - measurements to render.
 * @returns the table text.
 */
function table(rows: readonly Measurement[]): string {
  const header = '| case | messages | tools/msg | result KB | stream | log MB | heap MB | nodes |'
  const rule = '|---|---|---|---|---|---|---|---|'
  const body = rows.map(row => `| ${[
    row.label,
    String(row.shape.messages),
    String(row.shape.toolResultsPerMessage),
    (row.shape.toolResultBytes / 1024).toFixed(0),
    String(row.shape.streamChunks),
    (row.logBytes / 1024 / 1024).toFixed(1),
    (row.heapBytes / 1024 / 1024).toFixed(0),
    String(row.domNodes),
  ].join(' | ')} |`)
  return [header, rule, ...body].join('\n')
}

afterAll(() => {
  if (measurements.length > 0) {
    process.stdout.write(`\n=== session-size heap sweep ===\n${table(measurements)}\n`)
  }
})

it('measures the baseline transcript', async () => {
  const row = await measure('baseline', BASE_SHAPE)
  expect(row.heapBytes).toBeLessThan(HEAP_BUDGET_BYTES)
}, CASE_TIMEOUT_MS)

it('measures message-count growth', async () => {
  for (const messages of [200, 1_000]) {
    const row = await measure(`messages-${String(messages)}`, { ...BASE_SHAPE, messages })
    expect(row.heapBytes).toBeLessThan(HEAP_BUDGET_BYTES)
  }
}, CASE_TIMEOUT_MS * 2)

it('measures tool-result volume at the spill threshold', async () => {
  for (const toolResultsPerMessage of [10, 30]) {
    const row = await measure(`tools-${String(toolResultsPerMessage)}`, {
      ...BASE_SHAPE, toolResultsPerMessage, toolResultBytes: SPILL_INLINE_BYTES,
    })
    expect(row.heapBytes).toBeLessThan(HEAP_BUDGET_BYTES)
  }
}, CASE_TIMEOUT_MS * 2)

it('measures scroll-up accumulation without eviction', async () => {
  const row = await measure(
    'scroll-6-pages',
    { ...BASE_SHAPE, messages: 300, toolResultsPerMessage: 10, toolResultBytes: SPILL_INLINE_BYTES },
    5,
  )
  expect(row.heapBytes).toBeLessThan(HEAP_BUDGET_BYTES)
}, CASE_TIMEOUT_MS * 3)

it('measures embedded stream growth', async () => {
  const row = await measure('stream-5000', { ...BASE_SHAPE, streamChunks: 5_000 })
  expect(row.heapBytes).toBeLessThan(HEAP_BUDGET_BYTES)
}, CASE_TIMEOUT_MS)
