/**
 * Production host facts: Node's filesystem and child-process APIs, the
 * Landlock runner, and the location of the host Node-API addon.
 * @module
 */

import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launcherPath, probe as probeLandlock } from '@deepseek-ai/node-addon-system/landlock-run'
import type { DoctorEnvironment } from './types.ts'

/** The platform facts that locate the host Node-API addon. */
export interface AddonHost {
  readonly platform: NodeJS.Platform
  readonly arch: string
  /** Whether the C library is glibc; asked only on Linux. */
  glibc(): boolean
  /** Resolve a module specifier to a file path; throws when its package is absent. */
  resolve(specifier: string): string
}

/**
 * The host Node-API addon path for one platform, architecture, and C library.
 * @param host - platform facts and module resolution.
 * @returns `system.node` inside the installed platform package, or the path a
 *   build would create under `node_modules` when that package is absent.
 */
export function addonBinaryPath(host: AddonHost): string {
  const libc = host.platform === 'linux' ? (host.glibc() ? 'glibc' : 'musl') : undefined
  const binary = libc === undefined ? ['bin', 'system.node'] : ['bin', libc, 'system.node']
  const platformPackage = `@deepseek-ai/node-addon-system-${host.platform}-${host.arch}`
  let dir: string
  try {
    dir = dirname(host.resolve(`${platformPackage}/package.json`))
  } catch {
    // The platform package is absent: report the path a build would create.
    return join('node_modules', platformPackage, ...binary)
  }
  return join(dir, ...binary)
}

/**
 * The doctor's view of this process's host.
 * @returns host facts read through Node, the Landlock runner, and the installed addon packages.
 */
export function nodeEnvironment(): DoctorEnvironment {
  return {
    platform: process.platform,
    env: process.env,
    exists: path => existsSync(path),
    writable: (path) => {
      try {
        accessSync(path, constants.W_OK)
        return true
      } catch {
        // Not writable or absent: the caller reports which.
        return false
      }
    },
    readText: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // Missing sysctl or unreadable file: treated as unknown.
        return undefined
      }
    },
    spawn: (command, args, options) => {
      const result = spawnSync(command, [...args], { cwd: options.cwd, timeout: options.timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: result.error === undefined ? result.status : null, stdout: result.stdout, stderr: result.stderr }
    },
    launcherPath: () => launcherPath(),
    probeLandlock: () => probeLandlock(undefined, { timeoutMs: 3000 }),
    addonBinary: () => addonBinaryPath({
      platform: process.platform,
      arch: process.arch,
      glibc: () => {
        const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
        return Boolean(report?.header?.glibcVersionRuntime)
      },
      resolve: specifier => createRequire(import.meta.url).resolve(specifier),
    }),
  }
}
