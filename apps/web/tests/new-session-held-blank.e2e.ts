/** New Session in the shipped Web composition skips a blank Session that holds an active task, while startup restoration reopens it. */
import { chromium, type Page } from 'playwright'
import { describe, expect, it, onTestFinished } from 'vitest'
// Type-only: the Host `schedule` service merge the scaffold Context reads.
import type {} from '@deepseek-ai/dsh-schedule'
import { launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SETTLE = { timeout: 20_000 }
const TASK = { prompt: 'Call the vendor back', title: 'Call the vendor back', after_seconds: 18_000 }
const NOTE = 'Notes for the vendor call'

/** The Session navigation persists as the main selection. */
function selectedSession(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('dsh.sessions.current')
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return typeof value === 'object' && value !== null && 'sessionId' in value
      && typeof value.sessionId === 'string' ? value.sessionId : null
  })
}

/** The draft text the browser stores for one Session. */
function storedDraftText(page: Page, sessionId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const raw = localStorage.getItem(`dsh.conversation.${id}`)
    const value: unknown = raw === null ? null : JSON.parse(raw)
    if (typeof value !== 'object' || value === null || !('draft' in value)) return null
    const draft: unknown = value.draft
    if (typeof draft === 'string') return draft
    return typeof draft === 'object' && draft !== null && 'text' in draft && typeof draft.text === 'string' ? draft.text : null
  }, sessionId)
}

describe.skipIf(MODE === 'record')('web e2e: New Session beside a blank Session holding a task', () => {
  it('opens another Session instead of the held blank, and a reload reopens the held blank with its draft', async () => {
    const scaffold = await launchWebScaffold()
    onTestFinished(() => scaffold.close())
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'Held blank')
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await composer.waitFor()
      await expect.poll(() => workspace.sessionIds.length, SETTLE).toBe(1)
      const heldId = workspace.sessionIds[0]!
      await expect.poll(() => selectedSession(page), SETTLE).toBe(heldId)
      // Bind an active task to the blank Session through the Host Schedule service.
      await scaffold.ctx.schedule.create(heldId, TASK)
      await composer.fill(NOTE)
      await expect.poll(() => storedDraftText(page, heldId), SETTLE).toBe(NOTE)

      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      await expect.poll(() => workspace.sessionIds.length, SETTLE).toBe(2)
      const freshId = workspace.sessionIds.find(id => id !== heldId)!
      await expect.poll(() => selectedSession(page), SETTLE).toBe(freshId)
      expect(await scaffold.ctx.schedule.list({ sessionId: heldId })).toEqual([expect.objectContaining({ title: TASK.title })])
      expect(await scaffold.ctx.schedule.list({ sessionId: freshId })).toEqual([])

      // Restoration names the Session it last showed without asking the Host to skip active blanks.
      await page.evaluate((id) => { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })) }, heldId)
      await page.reload({ waitUntil: 'load' })
      await expect.poll(async () => (await composer.innerText()).trim(), SETTLE).toBe(NOTE)
      expect(await selectedSession(page)).toBe(heldId)
      expect(workspace.sessionIds).toHaveLength(2)
      expect(await scaffold.ctx.schedule.list({ sessionId: heldId })).toEqual([expect.objectContaining({ title: TASK.title })])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'web-e2e-new-session-held-blank')
      throw error
    }
  }, 120_000)
})
