/**
 * Render Hydra's PWA PNG icons from the light favicon: the dragon centered on
 * the manifest's white background, at the edges `APP_ICON_VARIANTS` declares.
 * `any` icons fill {@link ANY_ARTWORK_SCALE} of the edge; the maskable icon
 * keeps the square artwork inside the platform safe circle.
 * @module
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, MASKABLE_SAFE_RADIUS_RATIO } from './render-app-icons.ts'

/** Hydra's artwork: the light favicon, a 64 by 64 dragon. */
export const HYDRA_ICON_SOURCE = fileURLToPath(new URL('../public/favicon.svg', import.meta.url))

/** Opaque background behind the artwork, the manifest's `background_color`. */
export const HYDRA_ICON_BACKGROUND = '#ffffff'

/** Edge fraction the artwork fills in `any` icons. */
export const ANY_ARTWORK_SCALE = 0.72

/** Edge fraction of a square whose corners sit on the maskable safe circle. */
export const MASKABLE_HYDRA_ARTWORK_SCALE = Math.floor(2 * MASKABLE_SAFE_RADIUS_RATIO / Math.SQRT2 * 100) / 100

/**
 * Render every declared icon variant from the favicon.
 * @param source - the favicon SVG text.
 * @returns each variant's file name and PNG bytes.
 */
export async function renderHydraAppIcons(source: string): Promise<Map<string, Buffer>> {
  const { default: sharp } = await import('sharp')
  const icons = new Map<string, Buffer>()
  for (const variant of APP_ICON_VARIANTS) {
    const scale = variant.kind === 'maskable' ? MASKABLE_HYDRA_ARTWORK_SCALE : ANY_ARTWORK_SCALE
    const edge = Math.round(variant.size * scale)
    const artwork = await sharp(Buffer.from(source), { density: 72 * edge / 64 }).resize(edge, edge).png().toBuffer()
    const png = await sharp({ create: { width: variant.size, height: variant.size, channels: 4, background: HYDRA_ICON_BACKGROUND } })
      .composite([{ input: artwork, gravity: 'center' }])
      .png({ compressionLevel: 9 })
      .toBuffer()
    icons.set(variant.file, png)
  }
  return icons
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const icons = await renderHydraAppIcons(await readFile(HYDRA_ICON_SOURCE, 'utf8'))
  for (const [file, png] of icons) await writeFile(join(ICON_OUTPUT_DIRECTORY, file), png)
}
