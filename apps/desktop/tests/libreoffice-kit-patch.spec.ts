/** The Desktop runtime's LibreOffice kit patch: inside Electron's app.asar, a Linux host still reaches the WASM engine. */
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { DESKTOP_RUNTIME_PATCHES } from '../scripts/runtime-patch-policy.ts'

const REPOSITORY = resolve(import.meta.dirname, '../../..')
const SPEC = '@deepseek-ai/libreoffice-kit@0.1.5'
const run = promisify(execFile)
// Electron 44's asar fs wrapper returns null, not undefined, for a missing entry read with throwIfNoEntry: false.
// The probe gives Node that behavior and a glibc Linux host, then prints the engine the kit selects or why it cannot.
const PROBE = `import fs from 'node:fs'
import module from 'node:module'
import { pathToFileURL } from 'node:url'
const lstat = fs.lstatSync
fs.lstatSync = (path, options) => options?.throwIfNoEntry === false ? lstat(path, options) ?? null : lstat(path, options)
module.syncBuiltinESMExports()
Object.defineProperty(process, 'platform', { value: 'linux' })
process.report.getReport = () => ({ header: { glibcVersionRuntime: '2.35' } })
const kit = await import(pathToFileURL(process.argv[2]).href)
try {
  console.log('backend ' + (await kit.discoverRuntime()).backend)
} catch (error) {
  console.log(error.message)
}
`
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Run the probe against one kit entry.
 * @returns The engine the kit selected, or its resolution failure.
 */
async function selectedEngine(probe: string, entry: string): Promise<string> {
  const { stdout } = await run(process.execPath, [probe, entry], { timeout: 10_000 })
  return stdout.trim()
}

// The copied kit reaches its installed dependencies through symlinks, which Windows creates only with extra privileges.
it.skipIf(process.platform === 'win32')('keeps the WASM fallback reachable when Electron reports a missing package as null', async () => {
  const rule = DESKTOP_RUNTIME_PATCHES[SPEC]
  if (rule?.scope !== 'runtime-only') throw new Error(`${SPEC} must be a runtime-only Desktop patch`)
  const manifest = createRequire(join(REPOSITORY, 'apps/desktop-host/package.json')).resolve('@deepseek-ai/libreoffice-kit/package.json')
  // The patch is qualified against this exact bundle.
  expect((JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version).toBe('0.1.5')
  const installed = dirname(manifest)
  const root = mkdtempSync(join(tmpdir(), 'desktop-office-kit-'))
  roots.push(root)
  const patched = join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  cpSync(installed, patched, { recursive: true, dereference: true })
  for (const dependency of ['fflate', 'fontkit']) {
    const directory = (createRequire(manifest).resolve.paths(dependency) ?? [])
      .map(parent => join(parent, dependency)).find(candidate => existsSync(candidate))
    if (directory === undefined) throw new Error(`the installed kit cannot resolve ${dependency}`)
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    symlinkSync(directory, join(root, 'node_modules', dependency))
  }
  // The ceiling keeps git from treating an enclosing repository as the patch root.
  await run('git', ['apply', join(REPOSITORY, rule.path)], {
    cwd: patched, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) }, timeout: 10_000,
  })
  const probe = join(root, 'probe.mjs')
  writeFileSync(probe, PROBE)
  expect(await selectedEngine(probe, join(installed, 'lib', 'index.js'))).toMatch(/^Installed LibreOfficeKit package is incomplete/u)
  const engine = await selectedEngine(probe, join(patched, 'lib', 'index.js'))
  expect(engine).not.toMatch(/incomplete/u)
  expect(engine).toMatch(/^backend wasm$|@deepseek-ai\/libreoffice-kit-wasm\/package\.json/u)
}, 30_000)
