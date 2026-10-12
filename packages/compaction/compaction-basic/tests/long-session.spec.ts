import { describe, expect, it } from 'vitest'
import { reportLine, ROUTES, runSession } from './long-session-harness.ts'

describe('a long session on a provider denser than the harness guesses', () => {
  for (const [name, shape] of Object.entries(ROUTES)) {
    const turns = shape.faults === undefined ? 40 : 100
    it(`${name}: every turn completes for ${turns} turns`, async () => {
      const report = await runSession(name, shape, turns, 7)
      reportLine(`STRESS ${name} ${JSON.stringify(report)}`)
      expect(report.failedTurns).toEqual([])
    }, 600_000)
  }

  it.skipIf(process.env['DSH_STRESS_TURNS'] === undefined)('mid-32k: as many turns as DSH_STRESS_TURNS names, timed by quarter', async () => {
    const shape = ROUTES['mid-32k']
    if (shape === undefined) throw new Error('route missing')
    const turns = Number(process.env['DSH_STRESS_TURNS'])
    const report = await runSession('mid-32k-scaled', shape, turns, 13)
    reportLine(`STRESS mid-32k-scaled ${JSON.stringify(report)}`)
    expect(report.failedTurns).toEqual([])
  }, 1_800_000)

  it('mid-32k: two hundred turns complete and the per-turn cost stays flat', async () => {
    const shape = ROUTES['mid-32k']
    if (shape === undefined) throw new Error('route missing')
    const report = await runSession('mid-32k-long', shape, 200, 11)
    reportLine(`STRESS mid-32k-long ${JSON.stringify(report)}`)
    expect(report.failedTurns).toEqual([])
    expect(report.msPerTurnLastQuarter).toBeLessThanOrEqual(Math.max(50, report.msPerTurnFirstQuarter * 3))
  }, 600_000)
})
