/**
 * Opt-in browser memory measurement for a parent Session with many subagent
 * children.
 *
 * The reported failure was a JavaScript out-of-memory in Brave on a Session
 * that "had 19 sub-agent sessions", and the single-Session sweep in
 * `session-size.stress.ts` could not reach it: opening is bounded to one page
 * whatever the log holds. Each child the reader opens aside retains its own
 * scope and event window, and the Client store never evicts, so the suspected
 * multiplier is fan-out rather than one long transcript.
 *
 * This lane seeds one parent whose durable `subagent/catalog` events name real
 * seeded children, opens children one at a time through the header lineage,
 * and samples the renderer's exact heap through CDP after a forced collection.
 * Closing the panes and sampling again separates what a child costs while open
 * from what survives its release.
 */
import { basename, dirname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, type WebScaffold } from '../tests/scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from '../tests/support.ts'

/** One transcript's generated dimensions. */
interface Shape {
  /** Assistant replies, each preceded by its own user message and turn. */
  readonly messages: number
  /** Tool calls and their results inside each assistant step. */
  readonly toolResultsPerMessage: number
  /** Bytes of text in one tool result, before JSON escaping. */
  readonly toolResultBytes: number
}

/** Inline ceiling of `dsh-spill-policy` in `dsh-base`: a real tool result reaches this before it spills. */
const SPILL_INLINE_BYTES = 45_000

/** The child shape the directive fixes: a realistic delegated run. */
const CHILD_SHAPE: Shape = {
  messages: 30,
  toolResultsPerMessage: 10,
  toolResultBytes: SPILL_INLINE_BYTES,
}

/** The parent shape: long enough to page back, light enough to isolate fan-out. */
const PARENT_SHAPE: Shape = {
  messages: 120,
  toolResultsPerMessage: 2,
  toolResultBytes: 2_000,
}

/** Opening text of the parent's user messages, so its sidebar row is addressable among the children. */
const PARENT_MARKER = 'PARENTRUN'

/** Children the reported failure carried. */
const REPORTED_CHILDREN = 19

/** Wall-clock budget for one case: scaffold boot, seeding every child, open, settle, sample. */
const CASE_TIMEOUT_MS = 1_800_000

/** Heap a case may retain before this lane calls it a product defect rather than a measurement. */
const HEAP_BUDGET_BYTES = 1_500_000_000

/** One sampled point. */
interface Sample {
  readonly label: string
  /** Children present in the parent's catalog. */
  readonly children: number
  /** Children whose chat pane is open at the sample. */
  readonly opened: number
  /** Renderer heap after a forced collection. */
  readonly heapBytes: number
  /** Elements mounted in the whole document. */
  readonly domNodes: number
}

const openSamples: Sample[] = []

/**
 * Generate one tokenized Session log, ending on a closed turn.
 * @param shape - dimensions to generate.
 * @param sessionId - id the log's own header carries.
 * @param marker - text opening every user message, so the sidebar row and the
 *   transcript can be addressed without depending on row order.
 * @param catalog - durable child facts the parent announces, in creation order.
 * @returns the log's events, ready to append.
 */
function buildEvents(
  shape: Shape,
  sessionId: string,
  marker: string,
  catalog: readonly { readonly childId: string; readonly label: string; readonly createdAt: number }[] = [],
): SessionEvent[] {
  const time = 1784974100000
  const events: SessionEvent[] = []
  let seq = 0
  const at = (event: Record<string, unknown>): void => {
    events.push({ ...event, seq, time: time + seq } as unknown as SessionEvent)
    seq += 1
  }
  const filler = (bytes: number): string => 'x'.repeat(Math.max(bytes, 1))
  for (let turn = 1; turn <= shape.messages; turn++) {
    at({ type: 'turn/start', data: { turn, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'seed' } } } })
    at({ type: 'step/start', data: { turn, step: 1 } })
    at({
      type: 'user/message',
      data: {
        id: `${sessionId.slice(0, 8)}-0000-4000-9000-${String(turn).padStart(12, '0')}`,
        role: 'user',
        content: [{ type: 'text', text: `${marker} turn ${String(turn)} request. ${filler(200)}` }],
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
            { type: 'text', text: `Reply ${String(turn)}. ${filler(1_000)}` },
            ...callIds.map(callId => ({
              type: 'tool-call', id: callId, name: 'bash',
              arguments: JSON.stringify({ command: 'echo ok', description: 'stress call' }),
            })),
          ],
          source: { kind: 'model', provider: 'stress', model: 'stress' },
          id: `${sessionId.slice(0, 8)}-0000-4000-8000-${String(turn).padStart(12, '0')}`,
        },
        usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, reasoningTokens: 0 },
        stream: [{
          type: 'reasoning-chunks',
          time0: time + seq,
          index: 0,
          dt: Array.from({ length: 200 }, () => 0),
          texts: Array.from({ length: 200 }, (_, index) => ` token${String(index)}`),
        }],
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
            id: `${sessionId.slice(0, 8)}-0000-4000-7000-${String(resultSeq).padStart(12, '0')}`,
          },
        },
        sourceEventSeqs: [resultSeq - 1],
        surfaceOp: 'append',
      })
    }
    // The parent announces its children inside its first turn, the way a run
    // that delegated early does; the catalog projection folds these facts.
    if (turn === 1) {
      for (const child of catalog) {
        at({
          type: 'subagent/catalog',
          data: {
            version: 0,
            childId: child.childId,
            childCreatedAt: child.createdAt,
            mode: 'continuable',
            label: child.label,
          },
        })
      }
    }
    at({ type: 'step/end', data: { turn, step: 1 } })
    at({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

/**
 * Persist one Session through the shipped JSONL provider, with a header this
 * lane controls so a child can carry its subagent origin.
 * @param scaffold - the booted scaffold whose persistence root receives it.
 * @param header - the complete stored header.
 * @param events - the log to append.
 */
async function persist(
  scaffold: WebScaffold,
  header: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  const seeder = new Context()
  try {
    await seeder.plugin(JsonlSessionPersistence, { root: scaffold.persistenceRoot })
    const handle = await seeder.sessionPersistence.create(header)
    await handle.append(events)
    await handle.close()
  } finally {
    await seeder.fiber.dispose()
  }
}

/**
 * Seed one parent and `children` subagent children that its catalog names.
 * @param scaffold - the booted scaffold.
 * @param children - how many children to create.
 * @returns the seeded parent id and the bytes written across every log.
 */
async function seedFamily(
  scaffold: WebScaffold,
  children: number,
): Promise<{ readonly parentId: SessionId; readonly seededBytes: number }> {
  // Children are seeded older than their parent so the parent sorts first
  // among the ungrouped rows, which is how this lane addresses it.
  const createdAt = Date.now() - 600_000
  const parentId = SessionId(`fanout-parent-${String(children)}`)
  const facts: { childId: string; label: string; createdAt: number }[] = []
  let seededBytes = 0
  for (let index = 0; index < children; index++) {
    const childId = `fanout-child-${String(children)}-${String(index).padStart(2, '0')}`
    const childEvents = buildEvents(CHILD_SHAPE, childId, `CHILDRUN${String(index)}`)
    seededBytes += Buffer.byteLength(childEvents.map(event => JSON.stringify(event)).join('\n'))
    await persist(scaffold, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(childId),
      createdAt: createdAt + index,
      isSeeded: false,
      cwd: scaffold.workspaceCwd,
      delegationDepth: 1,
      origin: 'subagent',
      parentSession: parentId,
    }, childEvents)
    facts.push({ childId, label: `worker ${String(index + 1)}`, createdAt: createdAt + index })
  }
  const parentEvents = buildEvents(PARENT_SHAPE, parentId, PARENT_MARKER, facts)
  seededBytes += Buffer.byteLength(parentEvents.map(event => JSON.stringify(event)).join('\n'))
  await persist(scaffold, {
    version: SESSION_FORMAT_VERSION,
    id: parentId,
    createdAt: createdAt + 300_000,
    isSeeded: false,
    cwd: scaffold.workspaceCwd,
    delegationDepth: 0,
  }, parentEvents)
  return { parentId, seededBytes }
}

/**
 * Collect garbage and read the renderer's exact heap.
 * @param page - the measured page.
 * @returns used JS heap bytes.
 */
async function heapBytes(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('HeapProfiler.enable')
    await cdp.send('HeapProfiler.collectGarbage')
    const usage = await cdp.send('Runtime.getHeapUsage') as { usedSize: number }
    return usage.usedSize
  } finally {
    await cdp.detach()
  }
}

/**
 * Count every mounted element, so DOM growth is attributable beside the heap.
 * @param page - the measured page.
 * @returns mounted element count.
 */
function domNodes(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('*').length)
}

/**
 * Wait until the mounted element count stops moving, so a sample is taken on a
 * settled view rather than mid-render.
 * @param page - the measured page.
 * @returns the settled element count.
 */
async function settle(page: Page): Promise<number> {
  let previous = -1
  let stable = 0
  let nodes = 0
  for (let poll = 0; poll < 240 && stable < 3; poll++) {
    await page.waitForTimeout(500)
    nodes = await domNodes(page)
    stable = nodes === previous ? stable + 1 : 0
    previous = nodes
  }
  return nodes
}

/**
 * Open the seeded parent in a fresh page and wait for its newest turn.
 * @param scaffold - the booted scaffold.
 * @param page - the page to drive.
 */
async function openParent(scaffold: WebScaffold, page: Page): Promise<void> {
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 60_000 })
  await connectFreshWorkspace(page, dirname(scaffold.workspaceCwd), basename(scaffold.workspaceCwd))
  // A seeded Session is not attached to the Workspace entity, so the sidebar
  // files it under the collapsed Ungrouped group.
  const ungrouped = page.locator('[role="treeitem"]').filter({ hasText: 'Ungrouped' }).first()
  await ungrouped.waitFor({ timeout: 60_000 })
  if (await ungrouped.getAttribute('aria-expanded') === 'false') {
    await ungrouped.click()
    await page.waitForTimeout(1_000)
  }
  // Rows carry generated titles, not prompt text, so address the parent by
  // position: it is seeded newest, so it leads the ungrouped rows.
  const rows = page.locator('[role="treeitem"]')
  const labels = await rows.allInnerTexts()
  const groupIndex = labels.findIndex(label => label.includes('Ungrouped'))
  await rows.nth(groupIndex + 1).click()
  await page.locator('[class*="centerCol"]')
    .getByText(`Reply ${String(PARENT_SHAPE.messages)}.`, { exact: false })
    .first().waitFor({ timeout: 300_000 })
  await settle(page)
}

/**
 * Render collected samples as a table for the findings record.
 * @param rows - samples to render.
 * @returns the table text.
 */
function table(rows: readonly Sample[]): string {
  const header = '| case | children | opened | heap MB | elements |'
  const rule = '|---|---|---|---|---|'
  const body = rows.map(row => `| ${[
    row.label,
    String(row.children),
    String(row.opened),
    (row.heapBytes / 1024 / 1024).toFixed(0),
    String(row.domNodes),
  ].join(' | ')} |`)
  return [header, rule, ...body].join('\n')
}

afterAll(() => {
  if (openSamples.length > 0) {
    process.stdout.write(`\n=== subagent fan-out heap sweep ===\nfan-out at open\n${table(openSamples)}\n`)
  }
})

it('measures what a parent pays for children it never opens', async () => {
  for (const children of [0, 5, REPORTED_CHILDREN]) {
    const scaffold = await launchWebScaffold()
    const browser = await chromium.launch()
    try {
      const { seededBytes } = await seedFamily(scaffold, children)
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await openParent(scaffold, page)
      const sample: Sample = {
        label: `open-${String(children)}-children`,
        children,
        opened: 0,
        heapBytes: await heapBytes(page),
        domNodes: await domNodes(page),
      }
      openSamples.push(sample)
      process.stdout.write(
        `CASE ${sample.label}: seeded ${(seededBytes / 1024 / 1024).toFixed(0)} MB, `
        + `heap ${(sample.heapBytes / 1024 / 1024).toFixed(0)} MB, elements ${String(sample.domNodes)}\n`,
      )
      expect(tripwire.pageErrors.join('\n')).not.toMatch(/out of memory|heap/i)
      expect(sample.heapBytes).toBeLessThan(HEAP_BUDGET_BYTES)
    } finally {
      await browser.close()
      await scaffold.close()
    }
  }
}, CASE_TIMEOUT_MS)
