import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addonBinaryPath, nodeEnvironment } from '../src/host.ts'
import type { AddonHost } from '../src/host.ts'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/** A glibc Linux x64 host whose packages are all installed under `/pkgs`. */
function addonHost(overrides: Partial<AddonHost> = {}): AddonHost {
  return {
    platform: 'linux',
    arch: 'x64',
    glibc: () => true,
    resolve: specifier => join('/pkgs', specifier),
    ...overrides,
  }
}

function absent(): string {
  throw new Error('Cannot find module')
}

describe('the addon binary path', () => {
  it('points into the installed platform package, under the C library on Linux', () => {
    const linux = join('/pkgs', '@deepseek-ai/node-addon-system-linux-x64', 'bin')
    expect(addonBinaryPath(addonHost())).toBe(join(linux, 'glibc', 'system.node'))
    expect(addonBinaryPath(addonHost({ glibc: () => false }))).toBe(join(linux, 'musl', 'system.node'))
    const darwin = addonHost({ platform: 'darwin', arch: 'arm64', glibc: () => { throw new Error('the C library is asked only on Linux') } })
    expect(addonBinaryPath(darwin)).toBe(join('/pkgs', '@deepseek-ai/node-addon-system-darwin-arm64', 'bin', 'system.node'))
  })

  it('names the path a build would create when the platform package is absent', () => {
    expect(addonBinaryPath(addonHost({ resolve: absent })))
      .toBe(join('node_modules', '@deepseek-ai/node-addon-system-linux-x64', 'bin', 'glibc', 'system.node'))
    expect(addonBinaryPath(addonHost({ platform: 'win32', resolve: absent })))
      .toBe(join('node_modules', '@deepseek-ai/node-addon-system-win32-x64', 'bin', 'system.node'))
  })
})

describe('the production environment', () => {
  it('answers file, writability, and child-process questions from this host', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-doctor-host-'))
    const file = join(dir, 'fact.txt')
    await writeFile(file, 'fact\n')
    const missing = join(dir, 'missing')
    const host = nodeEnvironment()
    expect(host.platform).toBe(process.platform)
    expect(host.env).toBe(process.env)
    expect(host.exists(file)).toBe(true)
    expect(host.exists(missing)).toBe(false)
    expect(host.writable(dir)).toBe(true)
    expect(host.writable(missing)).toBe(false)
    expect(host.readText(file)).toBe('fact\n')
    expect(host.readText(missing)).toBeUndefined()
    const script = 'process.stdout.write("out"); process.stderr.write("err")'
    expect(host.spawn(process.execPath, ['-e', script], { cwd: dir, timeoutMs: 20_000 })).toEqual({ status: 0, stdout: 'out', stderr: 'err' })
    expect(host.spawn(missing, [], { timeoutMs: 20_000 }).status).toBeNull()
  })

  it('locates the Landlock runner and this platform addon, and probes the runner', () => {
    const host = nodeEnvironment()
    expect(host.launcherPath()).toMatch(/landlock-run$/)
    expect(['full', 'partial', 'unusable']).toContain(host.probeLandlock())
    expect(host.addonBinary()).toMatch(/system\.node$/)
  })
})
