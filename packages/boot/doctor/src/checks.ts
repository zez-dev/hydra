/**
 * Pure environment checks. Each reads only the injected
 * {@link DoctorEnvironment} and returns rows; nothing here mutates the host.
 * @module
 */

import { join } from 'node:path'
import { isHarnessError } from '@deepseek-ai/dsh-llm'
import type { DoctorEnvironment, DoctorReport, DoctorRow, DoctorStatus, DoctorSummary, ProbeErrorClass } from './types.ts'

/** Timeout for every child process a check spawns. */
const SPAWN_TIMEOUT_MS = 5000

/** The AppArmor switch that blocks bubblewrap's user namespaces on recent Ubuntu. */
const APPARMOR_USERNS = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

/** Remedy lines shared by rows; kept identical to the README's machine setup section. */
export const FIXES = {
  userns: 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 (persist it under /etc/sysctl.d), or install bubblewrap',
  landlock: 'sudo apt install musl-tools && (cd native/system && pnpm run build:native) to build the Landlock runner',
  addon: 'cd native/system && pnpm tsx ./scripts/build.ts --host-addon-only (or pnpm run build at the repo root)',
  home: 'export DSH_HOME=<writable directory> before running dsh; a .env file cannot set it',
  identity: 'git config user.name "<you>" && git config user.email "<you@example>" in the workspace (commits the harness makes are attributed to you)',
} as const

/**
 * Build one row; a fix is attached only when given.
 * @param section - report section.
 * @param check - check name.
 * @param status - verdict.
 * @param detail - observation.
 * @param fix - remedy for a warn or fail row.
 * @returns the row.
 */
export function row(section: string, check: string, status: DoctorStatus, detail: string, fix?: string): DoctorRow {
  return { section, check, status, detail, ...fix === undefined ? {} : { fix } }
}

/**
 * The text a row shows for a thrown value.
 * @param error - the value a `catch` received.
 * @returns the message of an `Error`, else the value as a string.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The first line of a multi-line observation.
 * @param text - process output or an error message.
 * @returns the text before its first line feed, or all of it when it has none.
 */
export function firstLine(text: string): string {
  return text.replace(/\n.*/s, '')
}

/** The DeepSeek Harness release Hydra is based on; taking an upstream release sets it. */
export const DEEPSEEK_HARNESS_VERSION = '0.2.2-alpha.2'

/**
 * The version row, so a pasted report names the Hydra release, the DeepSeek
 * Harness release it is based on, the Node.js version, and the platform.
 * @param env - host facts.
 * @returns one `ok` row.
 */
export function checkVersion(env: DoctorEnvironment): DoctorRow[] {
  const detail = `Hydra ${env.hydraVersion} on DeepSeek Harness ${DEEPSEEK_HARNESS_VERSION}, Node ${env.nodeVersion}, ${env.platform}-${env.arch}`
  return [row('about', 'version', 'ok', detail)]
}

/**
 * Home directory checks: `DSH_HOME`, writability, `.env`, and the profile.
 * @param env - host facts.
 * @param profile - profile name whose directory must be initialized.
 * @returns four rows.
 */
export function checkHome(env: DoctorEnvironment, profile: string): DoctorRow[] {
  const configured = env.env['DSH_HOME']
  const unset = configured === undefined || configured.trim() === ''
  const home = unset ? join(env.env['HOME'] ?? '~', '.dsh') : configured
  const dotenv = join(home, '.env')
  const manifest = join(home, 'profiles', profile, 'package.json')
  return [
    unset
      ? row('home', 'DSH_HOME', 'warn', `unset, defaulting to ${home}`, FIXES.home)
      : row('home', 'DSH_HOME', 'ok', home),
    env.exists(home) && env.writable(home)
      ? row('home', 'home writable', 'ok', home)
      : row('home', 'home writable', 'fail', env.exists(home) ? `${home} is not writable` : `${home} does not exist yet`, FIXES.home),
    env.exists(dotenv)
      ? row('home', '.env', 'ok', dotenv)
      : row('home', '.env', 'warn', `${dotenv} missing`, 'create it with your API keys, for example DEEPSEEK_API_KEY=...'),
    env.exists(manifest)
      ? row('home', `profile ${profile}`, 'ok', manifest)
      : row('home', `profile ${profile}`, 'warn', 'not initialized yet', `run hydra --profile ${profile} once; it initializes the profile`),
  ]
}

/** The workspace folders Hydra's plugins write. */
export const WORKSPACE_FOLDERS = ['.dsh/research', '.dsh/reports'] as const

/**
 * Workspace checks: Hydra folders, skills roots, and instruction files.
 * @param env - host facts.
 * @param cwd - the workspace root.
 * @returns one row per folder plus skills and instructions rows.
 */
export function checkWorkspace(env: DoctorEnvironment, cwd: string): DoctorRow[] {
  const rows: DoctorRow[] = WORKSPACE_FOLDERS.map(folder => (env.exists(join(cwd, folder))
    ? row('workspace', folder, 'ok', join(cwd, folder))
    : row('workspace', folder, 'warn', 'missing; created on first use', '/doctor --fix creates it now')))
  const skillRoots = ['.dsh/skills', '.agents/skills'].filter(root => env.exists(join(cwd, root)))
  rows.push(skillRoots.length > 0
    ? row('workspace', 'skills roots', 'ok', skillRoots.join(', '))
    : row('workspace', 'skills roots', 'warn', 'no project skills folder',
      'add SKILL.md folders under .dsh/skills or .agents/skills, or promote memories with /learn skill'))
  const instructions = ['AGENTS.md', 'CLAUDE.md'].filter(file => env.exists(join(cwd, file)))
  rows.push(instructions.length > 0
    ? row('workspace', 'instructions', 'ok', instructions.join(', '))
    : row('workspace', 'instructions', 'warn', 'no AGENTS.md or CLAUDE.md', 'write an AGENTS.md so every session starts with your project rules'))
  return rows
}

/**
 * Sandbox checks: bubblewrap (with the AppArmor user-namespace switch) and the
 * Landlock runner on Linux; the platform runner elsewhere.
 * @param env - host facts.
 * @returns rows for the platform's runner chain.
 */
export function checkSandbox(env: DoctorEnvironment): DoctorRow[] {
  if (env.platform !== 'linux') {
    const runner = env.platform === 'darwin' ? 'Seatbelt' : env.platform === 'win32' ? 'ACL restricted token' : env.platform
    return [row('sandbox', 'platform runner', 'ok', runner)]
  }
  const rows: DoctorRow[] = []
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--unshare-user', 'true']
  const bwrap = env.spawn('bwrap', args, { timeoutMs: SPAWN_TIMEOUT_MS })
  if (bwrap.status === 0) {
    rows.push(row('sandbox', 'bubblewrap', 'ok', 'user namespaces work'))
  } else {
    const restricted = env.readText(APPARMOR_USERNS)?.trim() === '1'
    const detail = bwrap.status === null
      ? 'bwrap is not installed'
      : `${firstLine((bwrap.stderr || 'probe failed').trim())}${restricted ? ' (kernel.apparmor_restrict_unprivileged_userns=1)' : ''}`
    rows.push(row('sandbox', 'bubblewrap', 'fail', detail, FIXES.userns))
  }
  const verdict = env.probeLandlock()
  if (verdict !== 'unusable') {
    rows.push(row('sandbox', 'landlock runner', 'ok', `${verdict} enforcement`))
  } else if (bwrap.status === 0) {
    rows.push(row('sandbox', 'landlock runner', 'ok', `${env.launcherPath()} unusable (bubblewrap covers it)`))
  } else {
    rows.push(row('sandbox', 'landlock runner', 'warn', `${env.launcherPath()} unusable`, FIXES.landlock))
  }
  return rows
}

/**
 * Native addon check: the host Node-API binary must exist for file leases.
 * @param env - host facts.
 * @returns one row.
 */
export function checkNativeAddon(env: DoctorEnvironment): DoctorRow[] {
  const binary = env.addonBinary()
  return [env.exists(binary)
    ? row('native', 'system.node', 'ok', binary)
    : row('native', 'system.node', 'fail', `${binary} missing; session leases and the bash tool fail`, FIXES.addon)]
}

/**
 * Git checks for the workspace: repository, identity, and cleanliness.
 * @param env - host facts.
 * @param cwd - the workspace root.
 * @returns rows for repository, identity, and status.
 */
export function checkGit(env: DoctorEnvironment, cwd: string): DoctorRow[] {
  const inside = env.spawn('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: SPAWN_TIMEOUT_MS })
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    const detail = inside.status === null ? 'git is not installed' : 'not a git repository'
    return [row('git', 'git repository', 'warn', detail, 'git init in the workspace so the harness can commit and diff its changes')]
  }
  const rows: DoctorRow[] = [row('git', 'git repository', 'ok', cwd)]
  const name = env.spawn('git', ['config', 'user.name'], { cwd, timeoutMs: SPAWN_TIMEOUT_MS })
  const email = env.spawn('git', ['config', 'user.email'], { cwd, timeoutMs: SPAWN_TIMEOUT_MS })
  const identified = name.status === 0 && email.status === 0 && name.stdout.trim() !== '' && email.stdout.trim() !== ''
  rows.push(identified
    ? row('git', 'git identity', 'ok', name.stdout.trim())
    : row('git', 'git identity', 'warn', 'no user.name or user.email', FIXES.identity))
  const status = env.spawn('git', ['status', '--porcelain'], { cwd, timeoutMs: SPAWN_TIMEOUT_MS })
  const dirty = status.stdout.split('\n').filter(line => line.trim() !== '').length
  rows.push(dirty === 0
    ? row('git', 'git status', 'ok', 'clean')
    : row('git', 'git status', 'warn', `${String(dirty)} changed path(s); a checkpoint would commit them with the round`,
      'commit or stash unrelated changes before starting a /qa goal'))
  return rows
}

/**
 * Classify a probe failure without exposing credentials.
 * @param error - the thrown value.
 * @returns the failure class.
 */
export function classifyProbeError(error: unknown): ProbeErrorClass {
  const code = isHarnessError(error) ? error.code : (error as { code?: unknown } | null)?.code
  if (code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL') return 'auth'
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return 'context'
  if (code === 'QUOTA' || code === 'RATE_LIMIT') return 'quota'
  const message = errorMessage(error)
  if (/401|403|unauthorized|invalid api key|authentication/i.test(message)) return 'auth'
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|timed out|timeout|abort/i.test(message)) return 'network'
  return 'error'
}

/**
 * Count rows by status.
 * @param rows - report rows.
 * @returns the counts.
 */
export function summarize(rows: readonly DoctorRow[]): DoctorSummary {
  let ok = 0
  let warn = 0
  let fail = 0
  for (const entry of rows) {
    if (entry.status === 'ok') ok += 1
    else if (entry.status === 'warn') warn += 1
    else fail += 1
  }
  return { ok, warn, fail }
}

/**
 * Render the plain-text table `/doctor` prints: one aligned line per row and
 * an indented fix under every warn or fail.
 * @param report - the report.
 * @returns the table text.
 */
export function renderReport(report: DoctorReport): string {
  const sectionWidth = Math.max(7, ...report.rows.map(entry => entry.section.length))
  const checkWidth = Math.max(5, ...report.rows.map(entry => entry.check.length))
  const lines = [`Hydra doctor (${report.generatedAt})`, '']
  for (const entry of report.rows) {
    lines.push(`${entry.status.toUpperCase().padEnd(4)}  ${entry.section.padEnd(sectionWidth)}  ${entry.check.padEnd(checkWidth)}  ${entry.detail}`)
    if (entry.fix !== undefined && entry.status !== 'ok') lines.push(`${''.padEnd(6 + sectionWidth + 2 + checkWidth + 2)}fix: ${entry.fix}`)
  }
  lines.push('', `${String(report.summary.ok)} ok, ${String(report.summary.warn)} warn, ${String(report.summary.fail)} fail`)
  return lines.join('\n')
}
