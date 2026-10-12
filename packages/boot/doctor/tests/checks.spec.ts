import { describe, expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  checkGit, checkHome, checkNativeAddon, checkSandbox, checkWorkspace, classifyProbeError, FIXES, renderReport, summarize,
} from '@deepseek-ai/dsh-doctor'
import type { DoctorEnvironment, DoctorRow } from '@deepseek-ai/dsh-doctor'

/** A fully passing fake host; each test overrides the piece it exercises. */
function environment(overrides: Partial<DoctorEnvironment> = {}): DoctorEnvironment {
  const files = new Set([
    '/home/u/.dsh', '/home/u/.dsh/.env', '/home/u/.dsh/profiles/web/package.json',
    '/work', '/work/.dsh/research', '/work/.dsh/reports', '/work/AGENTS.md', '/work/.git',
    '/addon/bin/glibc/system.node',
  ])
  return {
    platform: 'linux',
    env: { DSH_HOME: '/home/u/.dsh' },
    exists: path => files.has(path),
    writable: path => files.has(path),
    readText: path => (path === '/proc/sys/kernel/apparmor_restrict_unprivileged_userns' ? '0\n' : undefined),
    spawn: () => ({ status: 0, stdout: '', stderr: '' }),
    launcherPath: () => '/addon/bin/landlock-run',
    probeLandlock: () => 'full',
    addonBinary: () => '/addon/bin/glibc/system.node',
    ...overrides,
  }
}

function byCheck(rows: readonly DoctorRow[], check: string): DoctorRow {
  const row = rows.find(candidate => candidate.check === check)
  if (row === undefined) throw new Error(`no row for ${check}: ${rows.map(r => r.check).join(', ')}`)
  return row
}

describe('home checks', () => {
  it('passes with DSH_HOME set, writable, an .env, and an initialized profile', () => {
    const rows = checkHome(environment(), 'web')
    expect(rows.map(row => row.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('warns when DSH_HOME is unset and fails when the home is not writable', () => {
    const rows = checkHome(environment({ env: {}, writable: () => false }), 'web')
    expect(byCheck(rows, 'DSH_HOME').status).toBe('warn')
    expect(byCheck(rows, 'home writable').status).toBe('fail')
    expect(byCheck(rows, 'home writable').fix).toContain('DSH_HOME')
  })

  it('warns when .env is missing and when the profile is not initialized', () => {
    const rows = checkHome(environment({ exists: path => path === '/home/u/.dsh' }), 'web')
    expect(byCheck(rows, '.env').status).toBe('warn')
    expect(byCheck(rows, 'profile web').status).toBe('warn')
  })

  it('fails an existing home the user cannot write to', () => {
    const rows = checkHome(environment({ writable: () => false }), 'web')
    expect(byCheck(rows, 'home writable')).toEqual({
      section: 'home', check: 'home writable', status: 'fail', detail: '/home/u/.dsh is not writable', fix: FIXES.home,
    })
  })
})

describe('workspace checks', () => {
  it('reports the three Hydra folders, skills roots, and instruction files', () => {
    const rows = checkWorkspace(environment(), '/work')
    expect(byCheck(rows, 'instructions').status).toBe('ok')
    expect(byCheck(rows, 'skills roots').status).toBe('warn')
  })

  it('warns about a missing folder with the --fix hint', () => {
    const rows = checkWorkspace(environment({ exists: path => path === '/work' }), '/work')
    const row = byCheck(rows, '.dsh/reports')
    expect(row.status).toBe('warn')
    expect(row.fix).toContain('--fix')
    expect(byCheck(rows, 'instructions').status).toBe('warn')
  })

  it('passes the skills row with every project skills root that exists', () => {
    const present = new Set(['/work/.dsh/skills', '/work/.agents/skills'])
    const rows = checkWorkspace(environment({ exists: path => present.has(path) }), '/work')
    expect(byCheck(rows, 'skills roots')).toEqual({ section: 'workspace', check: 'skills roots', status: 'ok', detail: '.dsh/skills, .agents/skills' })
  })
})

describe('sandbox checks', () => {
  it('passes when bubblewrap runs', () => {
    const rows = checkSandbox(environment())
    expect(byCheck(rows, 'bubblewrap').status).toBe('ok')
    expect(byCheck(rows, 'landlock runner').status).toBe('ok')
  })

  it('fails with the AppArmor sysctl fix when bubblewrap cannot map user namespaces', () => {
    const rows = checkSandbox(environment({
      spawn: command => command === 'bwrap' ? { status: 1, stdout: '', stderr: 'bwrap: setting up uid map: Permission denied' } : { status: 0, stdout: '', stderr: '' },
      readText: path => (path.endsWith('apparmor_restrict_unprivileged_userns') ? '1\n' : undefined),
      probeLandlock: () => 'unusable',
    }))
    const bwrap = byCheck(rows, 'bubblewrap')
    expect(bwrap.status).toBe('fail')
    expect(bwrap.fix).toContain('kernel.apparmor_restrict_unprivileged_userns=0')
    expect(byCheck(rows, 'landlock runner').status).toBe('warn')
    expect(byCheck(rows, 'landlock runner').fix).toContain('musl-tools')
  })

  it('skips the Linux runners on other platforms', () => {
    const rows = checkSandbox(environment({ platform: 'darwin' }))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('ok')
  })

  it('names the Windows runner and any other platform by name', () => {
    expect(checkSandbox(environment({ platform: 'win32' }))).toEqual([{ section: 'sandbox', check: 'platform runner', status: 'ok', detail: 'ACL restricted token' }])
    expect(checkSandbox(environment({ platform: 'freebsd' }))).toEqual([{ section: 'sandbox', check: 'platform runner', status: 'ok', detail: 'freebsd' }])
  })

  it('reports a missing bwrap as not installed and keeps only the first line of its error otherwise', () => {
    const missing = checkSandbox(environment({ spawn: () => ({ status: null, stdout: '', stderr: '' }), probeLandlock: () => 'partial' }))
    expect(byCheck(missing, 'bubblewrap').detail).toBe('bwrap is not installed')
    expect(byCheck(missing, 'landlock runner')).toMatchObject({ status: 'ok', detail: 'partial enforcement' })

    const silent = checkSandbox(environment({ spawn: () => ({ status: 1, stdout: '', stderr: '' }) }))
    expect(byCheck(silent, 'bubblewrap').detail).toBe('probe failed')

    const verbose = checkSandbox(environment({ spawn: () => ({ status: 1, stdout: '', stderr: 'bwrap: Creating new namespace failed\nsee dmesg\n' }) }))
    expect(byCheck(verbose, 'bubblewrap').detail).toBe('bwrap: Creating new namespace failed')
  })

  it('accepts an unusable Landlock runner while bubblewrap works', () => {
    const rows = checkSandbox(environment({ probeLandlock: () => 'unusable' }))
    expect(byCheck(rows, 'landlock runner')).toEqual({
      section: 'sandbox', check: 'landlock runner', status: 'ok', detail: '/addon/bin/landlock-run unusable (bubblewrap covers it)',
    })
  })
})

describe('native addon and git checks', () => {
  it('fails with the host-addon build command when system.node is missing', () => {
    const rows = checkNativeAddon(environment({ exists: () => false }))
    expect(rows[0]!.status).toBe('fail')
    expect(rows[0]!.fix).toContain('--host-addon-only')
    expect(checkNativeAddon(environment())[0]!.status).toBe('ok')
  })

  it('reports repository, identity, and cleanliness from git', () => {
    const answers: Record<string, string> = { 'rev-parse': 'true\n', 'config user.name': 'ice\n', 'config user.email': 'a@b\n', status: ' M x.ts\n' }
    const rows = checkGit(environment({
      spawn: (_command, args) => ({ status: 0, stdout: answers[args.slice(0, 2).join(' ')] ?? answers[args[0]!] ?? '', stderr: '' }),
    }), '/work')
    expect(byCheck(rows, 'git repository').status).toBe('ok')
    expect(byCheck(rows, 'git identity').status).toBe('ok')
    expect(byCheck(rows, 'git status').status).toBe('warn')
  })

  it('warns when the git identity is missing', () => {
    const rows = checkGit(environment({ spawn: (_c, args) => ({ status: args[0] === 'config' ? 1 : 0, stdout: args[0] === 'rev-parse' ? 'true\n' : '', stderr: '' }) }), '/work')
    expect(byCheck(rows, 'git identity').status).toBe('warn')
    expect(byCheck(rows, 'git identity').fix).toContain('git config user.name')
  })

  it('tells a missing git apart from a folder outside any repository', () => {
    const missing = checkGit(environment({ spawn: () => ({ status: null, stdout: '', stderr: '' }) }), '/work')
    expect(missing).toEqual([expect.objectContaining({ check: 'git repository', status: 'warn', detail: 'git is not installed' })])
    const outside = checkGit(environment({ spawn: () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' }) }), '/work')
    expect(outside).toEqual([expect.objectContaining({ check: 'git repository', status: 'warn', detail: 'not a git repository' })])
  })
})

describe('probe classification and rendering', () => {
  it('classifies auth, context, quota, network, and other failures', () => {
    expect(classifyProbeError(Object.assign(new Error('bad key'), { code: 'INVALID_CREDENTIAL' }))).toBe('auth')
    expect(classifyProbeError(Object.assign(new Error('too long'), { code: 'CONTEXT_WINDOW_EXCEEDED' }))).toBe('context')
    expect(classifyProbeError(Object.assign(new Error('quota'), { code: 'QUOTA' }))).toBe('quota')
    expect(classifyProbeError(new Error('fetch failed: ECONNREFUSED'))).toBe('network')
    expect(classifyProbeError(new Error('weird'))).toBe('error')
  })

  it('classifies a harness error by its code and other failures by their text', () => {
    expect(classifyProbeError(new HarnessError('slow down', 'RATE_LIMIT'))).toBe('quota')
    expect(classifyProbeError(new Error('Request failed with status 403'))).toBe('auth')
    expect(classifyProbeError('HTTP 401 Unauthorized')).toBe('auth')
    expect(classifyProbeError(null)).toBe('error')
  })

  it('renders a table with one line per row and a summary', () => {
    const rows: DoctorRow[] = [
      { section: 'home', check: 'DSH_HOME', status: 'ok', detail: '/home/u/.dsh' },
      { section: 'sandbox', check: 'bubblewrap', status: 'fail', detail: 'uid map denied', fix: 'sudo sysctl -w x=0' },
    ]
    const text = renderReport({ generatedAt: '2026-09-21T00:00:00.000Z', rows, summary: summarize(rows) })
    expect(text).toMatch(/FAIL +sandbox +bubblewrap/)
    expect(text).toContain('fix: sudo sysctl -w x=0')
    expect(text).toContain('1 ok, 0 warn, 1 fail')
  })
})
