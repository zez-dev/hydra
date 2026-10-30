import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { chromium, type Page } from 'playwright'
import { APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, MASKABLE_SAFE_RADIUS_RATIO } from '../scripts/render-app-icons.ts'
import {
  ANY_ARTWORK_SCALE, HYDRA_ICON_SOURCE, MASKABLE_HYDRA_ARTWORK_SCALE, renderHydraAppIcons,
} from '../scripts/render-hydra-app-icons.ts'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

async function pixels(page: Page, url: string, size: number) {
  return page.evaluate(async ({ url, size }) => {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0, size, size)
    const { data } = context.getImageData(0, 0, size, size)
    let radius = 0
    let ink = 0
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const at = (y * size + x) * 4
        if (data[at + 3] === 0 || data[at]! + data[at + 1]! + data[at + 2]! >= 384) continue
        ink += 1
        radius = Math.max(radius, Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2))
      }
    }
    return {
      width: image.naturalWidth, height: image.naturalHeight, radius, ink,
      corners: [0, size - 1, (size - 1) * size, size * size - 1].map(index => data[index * 4 + 3]),
    }
  }, { url, size })
}

function pngUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

function svgUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')
  expect(index).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />')
  expect(index).toContain('<meta name="mobile-web-app-capable" content="yes" />')
  expect(index).toContain('<meta name="apple-mobile-web-app-title" content="Hydra" />')
  // No `theme-color` here: `ThemePresenter` owns the single metadata node and
  // follows the resolved in-application theme, which a static media query
  // cannot. The manifest's `theme_color` covers the surrounding chrome before
  // the presenter runs, and `settings-chrome.e2e.ts` pins the live contract.

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: 'Hydra',
    short_name: 'Hydra',
    start_url: './',
    scope: './',
    // `standalone` keeps the phone's status bar; `fullscreen` hides it and the
    // navigation bar, which strands a chat surface with no clock or battery.
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#b91c1c',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  })
})

it('decodes every generated and shipped icon with its full artwork and opaque corners', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const source = await readFile(HYDRA_ICON_SOURCE, 'utf8')
    const generated = await renderHydraAppIcons(source)
    const manifest = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8')) as {
      icons: readonly { src: string; sizes: string }[]
    }
    const declared = [...manifest.icons, { src: 'apple-touch-icon.png', sizes: '180x180' }]
    expect(APP_ICON_VARIANTS.map(variant => [variant.file, `${variant.size}x${variant.size}`]))
      .toEqual(declared.map(icon => [icon.src, icon.sizes]))
    for (const variant of APP_ICON_VARIANTS) {
      const reference = await pixels(page, svgUrl(source), variant.size)
      expect(reference.ink).toBeGreaterThan(0)
      const scale = variant.kind === 'maskable' ? MASKABLE_HYDRA_ARTWORK_SCALE : ANY_ARTWORK_SCALE
      for (const bytes of [generated.get(variant.file)!, await readFile(join(DIST_ROOT, variant.file))]) {
        const image = await pixels(page, pngUrl(bytes), variant.size)
        expect([image.width, image.height], variant.file).toEqual([variant.size, variant.size])
        expect(image.corners, variant.file).toEqual([255, 255, 255, 255])
        expect(image.ink, variant.file).toBeGreaterThan(0)
        // Two pixels allow rasterizer and downsampling differences without
        // accepting missing or undersized artwork in the published PNG.
        expect(Math.abs(image.radius - reference.radius * scale), variant.file).toBeLessThan(2)
      }
    }
  } finally { await browser.close() }
})

it('ships fixed-color favicons selected by document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const dark = await readFile(join(DIST_ROOT, 'favicon-dark.svg'), 'utf8')
  expect(light).not.toContain('<style>')
  expect(light).toContain('fill="#b91c1c"')
  expect(dark).toContain('fill="#f87171"')
  expect(dark.replace('fill="#f87171"', 'fill="#b91c1c"').replaceAll('fill="#070708"', 'fill="#ffffff"')).toBe(light)
})

it('keeps antialiased edges on the Apple icon artwork', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const png = await readFile(join(ICON_OUTPUT_DIRECTORY, 'apple-touch-icon.png'))
    const partial = await page.evaluate(async (source) => {
      const image = new Image()
      image.src = source
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 180
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0, 180, 180)
      const { data } = context.getImageData(0, 0, 180, 180)
      const at = (x: number, y: number): readonly [number, number, number] => {
        const index = (y * 180 + x) * 4
        return [data[index]!, data[index + 1]!, data[index + 2]!]
      }
      const ink = ([r, g, b]: readonly [number, number, number]): boolean => r > 150 && g < 60 && b < 60
      const paper = ([r, g, b]: readonly [number, number, number]): boolean => r > 245 && g > 245 && b > 245
      let count = 0
      for (let y = 1; y < 179; y += 1) {
        for (let x = 1; x < 179; x += 1) {
          const color = at(x, y)
          if (ink(color) || paper(color)) continue
          // A blend of the dragon's red and the white background between a red and
          // a white neighbor is edge coverage, not the amber eyes.
          const neighbors = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)]
          if (neighbors.some(ink) && neighbors.some(paper) && color[0] > color[1]) count += 1
        }
      }
      return count
    }, pngUrl(png))
    expect(partial).toBeGreaterThan(20)
  } finally { await browser.close() }
})

it('keeps the shipped maskable artwork inside its opaque platform safe zone', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const maskable = await readFile(join(DIST_ROOT, 'icon-maskable-512.png'))
    const full = await readFile(join(DIST_ROOT, 'icon-512.png'))
    const size = APP_ICON_VARIANTS.find(variant => variant.kind === 'maskable')!.size
    const scaled = await pixels(page, pngUrl(maskable), size)
    const unscaled = await pixels(page, pngUrl(full), size)
    expect(scaled.radius).toBeLessThanOrEqual(MASKABLE_SAFE_RADIUS_RATIO * size)
    expect(scaled.radius).toBeGreaterThan(unscaled.radius * MASKABLE_HYDRA_ARTWORK_SCALE / ANY_ARTWORK_SCALE - 2)
    expect(scaled.corners).toEqual([255, 255, 255, 255])
    expect(unscaled.radius).toBeGreaterThan(MASKABLE_SAFE_RADIUS_RATIO * size)
  } finally {
    await browser.close()
  }
})
