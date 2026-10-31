/** electron-builder settings for the unsigned Linux x64 build: its formats, executable, and package identity. */
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

  it('builds the AppImage on the static runtime, which needs no libfuse2 on the PC', () => {
    expect(createElectronBuilderConfig(LINUX, 'linux', 'x64').toolsets).toEqual({ appimage: '1.0.3' })
  })
})
