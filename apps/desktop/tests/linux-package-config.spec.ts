/** electron-builder settings for the unsigned Linux x64 build: its formats, executable, icon, and package identity. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertIcon, getPngSize } from 'app-builder-lib/out/util/iconConverter.js'
import { describe, expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

const LINUX = {
  DSH_DESKTOP_APP_ID: 'com.hydra.harness',
  DSH_DESKTOP_TARGET_PLATFORM: 'linux',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
}

describe('Linux package configuration', () => {
  it('builds an AppImage and a .deb whose executable and package name Hydra', () => {
    const config = createElectronBuilderConfig(LINUX, 'linux', 'x64')
    expect(config.linux).toMatchObject({
      target: ['AppImage', 'deb'],
      executableName: 'hydra',
      vendor: 'Hydra',
      category: 'Development',
    })
    expect(config.deb).toEqual({ packageName: 'hydra' })
    expect(config.linux.maintainer).not.toMatch(/deepseek/iu)
    expect(config.linux.description).toContain('not affiliated with or endorsed by DeepSeek')
    expect(config.artifactName).toBe('hydra-${version}-${os}-${arch}-unsigned.${ext}')
    expect(config.directories.output).toContain('linux-x64')
  })

  it('gives the .deb a homepage and ties Hydra windows to hydra.desktop', () => {
    const config = createElectronBuilderConfig(LINUX, 'linux', 'x64')
    expect(config.extraMetadata).toMatchObject({ homepage: 'https://github.com/zez-dev/hydra', desktopName: 'hydra.desktop' })
    expect(config.linux.syncDesktopName).toBe(true)
  })

  it('installs the icon at the hicolor theme sizes, which stop at 512 px', async () => {
    const config = createElectronBuilderConfig(LINUX, 'linux', 'x64')
    const outDir = mkdtempSync(join(tmpdir(), 'hydra-linux-icons-'))
    const { icons, isFallback } = await convertIcon({ sources: [config.linux.icon], fallbackSources: [], roots: [], format: 'set', outDir })
    expect(isFallback).toBeFalsy()
    expect(icons.map(icon => icon.size)).toEqual([16, 24, 32, 48, 64, 128, 256, 512])
    for (const icon of icons) expect(await getPngSize(icon.file)).toEqual({ width: icon.size, height: icon.size })
  })

  it('builds the AppImage on the static runtime, which needs no libfuse2 on the PC', () => {
    expect(createElectronBuilderConfig(LINUX, 'linux', 'x64').toolsets).toEqual({ appimage: '1.0.3' })
  })
})
