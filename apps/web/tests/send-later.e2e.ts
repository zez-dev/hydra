/** Send later schedules the composer draft as a one-time task of the composer's Session. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator } from 'playwright'
import { describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
// Type-only: the Host `schedule` service merge the scaffold Context reads.
import type {} from '@deepseek-ai/dsh-schedule'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, pinBrowserClock, pinHostClock, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/send-later', import.meta.url))
const MODE = webSnapshotMode()
const DRAFT = 'Summarize the open pull requests'
const CUSTOM_DRAFT = 'Draft the weekly report'
const HOUR_MS = 3_600_000

/**
 * Read each target stamp of the open menu and replace it with a token, so the
 * golden pins the menu's rows while the instants are checked by value.
 * @param menu - the open Send later menu.
 * @returns the instants the rows name, in menu order, and the token replacements.
 */
async function presetStamps(menu: Locator): Promise<{
  readonly instants: readonly number[]
  readonly replacements: readonly (readonly [string, string])[]
}> {
  const stamps = menu.locator('time')
  const count = await stamps.count()
  const instants: number[] = []
  const replacements: (readonly [string, string])[] = []
  for (let index = 0; index < count; index++) {
    const stamp = stamps.nth(index)
    instants.push(Date.parse(await stamp.getAttribute('datetime') ?? ''))
    replacements.push([await stamp.innerText(), `{{target:${String(index + 1)}}}`])
  }
  return { instants, replacements }
}

describe.skipIf(MODE === 'record')('web e2e: Send later', () => {
  it('schedules the composer draft as a task of its Session, which Automation tasks can cancel', async () => {
    const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
    const hostClock = pinHostClock()
    // Teardown runs after the body's own failure is recorded, so a close error cannot replace it.
    onTestFinished(async () => {
      try { await resources.browser?.close() } finally {
        try { await resources.scaffold?.close() } finally { hostClock.mockRestore() }
      }
    })
    const fixture = await selectedSessionFixture(FIXTURE, false)
    const scaffold = await launchWebScaffold({ replayFixture: fixture, compareReplaySession: false, paceMs: 5 })
    resources.scaffold = scaffold
    const browser = await chromium.launch()
    resources.browser = browser
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-send-later'))
    await pinBrowserClock(page)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('[data-composer-input]').first()
    const sendLater = page.getByRole('button', { name: 'Send later', exact: true })

    // New Session reuses a Session that has not started a turn, so its draft is not scheduled there.
    await input.fill(DRAFT)
    await sendLater.waitFor()
    expect(await sendLater.isDisabled()).toBe(true)
    await input.fill('')
    await sendLater.waitFor({ state: 'detached' })
    const prompts = fixtureUserPrompts(await readFile(fixture, 'utf8'))
    expect(prompts).toHaveLength(1)
    const settled = scaffold.whenTurnSettled()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await settled

    await input.fill(DRAFT)
    await expect.poll(() => sendLater.isEnabled()).toBe(true)
    await compareOrRefreshGolden(join(EXPECTED, 'composer.expected.md'),
      await captureStableAria(page, '[data-composer-card]', scaffold.workspaceCwd), MODE)

    await sendLater.click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    const opened = await page.evaluate(() => Date.now())
    const { instants, replacements } = await presetStamps(menu)
    expect(instants).toHaveLength(3)
    // In 5 hours is a delay; Tomorrow and In 2 days keep the opening minute in the page's zone.
    expect(Math.abs(instants[0]! - (opened + 5 * HOUR_MS))).toBeLessThan(5_000)
    expect(instants[1]! % 60_000).toBe(0)
    expect(opened + 24 * HOUR_MS - instants[1]!).toBeGreaterThanOrEqual(0)
    expect(opened + 24 * HOUR_MS - instants[1]!).toBeLessThan(60_000)
    expect(instants[2]! - instants[1]!).toBe(24 * HOUR_MS)
    await compareOrRefreshGolden(join(EXPECTED, 'menu.expected.md'),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd, { replacements }), MODE)

    await menu.getByRole('menuitem', { name: /^In 5 hours/ }).click()
    const confirmation = page.getByRole('alert').filter({ hasText: 'Message scheduled for' })
    await confirmation.waitFor()
    await sendLater.waitFor({ state: 'detached' })
    expect((await input.innerText()).trim()).toBe('')
    const tasks = await scaffold.ctx.schedule.list({ sessionId })
    expect(tasks).toEqual([expect.objectContaining({
      kind: 'after', title: DRAFT, prompt: DRAFT, afterSeconds: 18_000,
    })])
    await page.getByRole('button', { name: '1 reminder', exact: true }).waitFor()

    // View task opens the task tab, whose deletion cancels the send.
    await confirmation.getByRole('button', { name: 'View task', exact: true }).click()
    const actions = page.getByRole('button', { name: 'Automation task actions', exact: true })
    await actions.waitFor()
    await actions.click()
    await page.getByRole('menuitem', { name: 'Delete task', exact: true }).click()
    await page.getByRole('dialog', { name: 'Delete this task?' })
      .getByRole('button', { name: 'Confirm deletion', exact: true }).click()
    await expect.poll(() => scaffold.ctx.schedule.list({ sessionId })).toEqual([])

    await input.fill(CUSTOM_DRAFT)
    await expect.poll(() => sendLater.isEnabled()).toBe(true)
    await sendLater.click()
    await page.getByRole('menuitem', { name: 'Custom date and time…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Send later', exact: true })
    await dialog.waitFor()
    const date = await dialog.getByRole('button', { name: 'Date', exact: true }).innerText()
    const time = await dialog.getByRole('button', { name: 'Time', exact: true }).innerText()
    await compareOrRefreshGolden(join(EXPECTED, 'dialog.expected.md'), await captureStableAria(
      page, '[role="dialog"][aria-label="Send later"]', scaffold.workspaceCwd,
      { replacements: [[date, '{{date}}'], [time, '{{time}}']] },
    ), MODE)
    await dialog.getByRole('button', { name: 'Schedule', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    // The dialog's local date and time are resolved in the page's zone, Asia/Shanghai (UTC+8).
    const [year, month, day] = date.trim().split('/').map(Number)
    const [hour, minute, second] = time.trim().split(':').map(Number)
    const scheduledAt = new Date(Date.UTC(year!, month! - 1, day, hour! - 8, minute, second)).toISOString()
    expect(await scaffold.ctx.schedule.list({ sessionId })).toEqual([expect.objectContaining({
      kind: 'at', title: CUSTOM_DRAFT, prompt: CUSTOM_DRAFT, scheduledAt,
    })])
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(EXPECTED, ['composer.expected.md', 'dialog.expected.md', 'menu.expected.md'])
  })
})
