/** The Hydra palette: red brand tokens resolve in both appearances, the dark canvas is black, and every text pair meets WCAG AA. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseRules } from './stylesheet-scan.ts'

const SHEET = readFileSync(fileURLToPath(new URL('../src/styles/design-platform.css', import.meta.url)), 'utf8')

/** Merge every declaration whose selector matches into one variable map, later rules winning. */
function variablesFor(selector: string): Map<string, string> {
  const vars = new Map<string, string>()
  for (const rule of parseRules(SHEET)) {
    if (!rule.selectors.includes(selector)) continue
    for (const [property, value] of rule.declarations) {
      if (property.startsWith('--')) vars.set(property, value)
    }
  }
  return vars
}

/** Resolve `var(--x)` chains to a literal color string. */
function resolve(vars: Map<string, string>, name: string, depth = 0): string {
  const value = vars.get(name)
  if (value === undefined) throw new Error(`${name} is not defined`)
  const match = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim())
  if (match === null) return value.trim()
  if (depth > 12) throw new Error(`${name} resolves through too many aliases`)
  return resolve(vars, match[1] as string, depth + 1)
}

function rgb(color: string): [number, number, number] {
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color)
  if (fn !== null) return [Number(fn[1]), Number(fn[2]), Number(fn[3])]
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex !== null) {
    const n = Number.parseInt(hex[1] as string, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  throw new Error(`unsupported color ${color}`)
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two literal colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Check that a color reads as red: the red channel dominates green and blue. */
function isRed(color: string): boolean {
  const [r, g, b] = rgb(color)
  return r > g + 60 && r > b + 60
}

/** Opaque fills that carry body text: the canvas, the three layers, the sidebar, and selected or hovered rows. */
const TEXT_SURFACES = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-specific-sidebar-fill',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-specific-sidebar-nav-item-active',
] as const

const LIGHT = { ...Object.fromEntries(variablesFor('body')) }
const DARK = { ...LIGHT, ...Object.fromEntries(variablesFor('body[data-ds-dark-theme]')) }

describe('Hydra palette', () => {
  for (const [label, vars] of [['light', new Map(Object.entries(LIGHT))], ['dark', new Map(Object.entries(DARK))]] as const) {
    describe(label, () => {
      const bg = () => resolve(vars, '--dsw-alias-bg-base')

      it('uses a red brand primary, brand text, and link', () => {
        for (const token of ['--dsw-alias-brand-primary', '--dsw-alias-brand-text', '--dsw-alias-link']) {
          expect(isRed(resolve(vars, token)), `${token} = ${resolve(vars, token)}`).toBe(true)
        }
      })

      it(label === 'dark' ? 'sits on a black canvas' : 'sits on a white canvas', () => {
        const [r, g, b] = rgb(bg())
        if (label === 'dark') expect(Math.max(r, g, b)).toBeLessThanOrEqual(12)
        else expect(Math.min(r, g, b)).toBeGreaterThanOrEqual(250)
      })

      it('keeps link and brand text readable against the base background (AA 4.5:1)', () => {
        for (const token of ['--dsw-alias-link', '--dsw-alias-brand-text']) {
          expect(contrast(resolve(vars, token), bg()), token).toBeGreaterThanOrEqual(4.5)
        }
      })

      it('keeps secondary and tertiary labels readable on every text surface (AA 4.5:1)', () => {
        for (const surface of TEXT_SURFACES) {
          for (const token of ['--dsw-alias-label-secondary', '--dsw-alias-label-tertiary']) {
            expect(contrast(resolve(vars, token), resolve(vars, surface)), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5)
          }
        }
      })

      it('keeps caption hints at 3:1 on the canvas and layers', () => {
        for (const surface of TEXT_SURFACES.slice(0, 6)) {
          expect(contrast(resolve(vars, '--dsw-alias-label-caption'), resolve(vars, surface)), surface).toBeGreaterThanOrEqual(3)
        }
      })

      it('keeps the primary button label readable on its fill (AA 4.5:1)', () => {
        expect(contrast(resolve(vars, '--dsw-alias-button-primary-fill'), resolve(vars, '--dsw-alias-label-primary-foreground')))
          .toBeGreaterThanOrEqual(4.5)
      })

      it('keeps the brand primary distinguishable from the base background (3:1 for UI components)', () => {
        expect(contrast(resolve(vars, '--dsw-alias-brand-primary'), bg())).toBeGreaterThanOrEqual(3)
      })

      it('defines the ember highlight', () => {
        expect(resolve(vars, '--dsw-alias-brand-highlight')).toMatch(/^rgb\(247, 173, 49\)$/)
      })
    })
  }

  it('retires the DeepSeek blue from the static scale', () => {
    expect(SHEET).not.toContain('rgb(65, 118, 230)')
    expect(SHEET).not.toContain('rgb(86, 134, 254)')
  })
})
