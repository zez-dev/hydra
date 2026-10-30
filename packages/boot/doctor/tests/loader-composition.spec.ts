// Real composition: a base-like stack booted from a cordis.yml through the
// Loader; `/doctor` reads the tools row's compat config and each pi-ai row's
// provider key references from the Loader, and lists the mounted Hydra
// services and every Loader row that did not activate. A second stack boots
// a dsh profile with the settings service the web Models page writes through.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import * as Doctor from '@deepseek-ai/dsh-doctor'
import type { DoctorEnvironment } from '@deepseek-ai/dsh-doctor'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

let root: string | undefined
let home: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, home]) if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  root = undefined
  home = undefined
  vi.unstubAllEnvs()
})

/** The tools row of a composition that ships both compat settings on. */
const COMPAT_TOOLS_ROW = [
  '- id: tools',
  "  name: '@deepseek-ai/dsh-tools'",
  '  config:',
  '    argumentCoercion: lenient',
  '    nullableParameters: flat',
]

/**
 * Boot the base-like stack plus `rows` through the Loader.
 * @param rows - cordis.yml rows after the base stack, including the tools row.
 * @param modules - extra Loader imports the rows name.
 * @returns the root context once every row settled, including rows that failed.
 */
async function boot(rows: readonly string[] = COMPAT_TOOLS_ROW, modules: Readonly<Record<string, unknown>> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-doctor-loader-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-doctor-home-'))
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    ...rows,
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-commands'",
    '- id: doctor',
    "  name: '@deepseek-ai/dsh-doctor'",
    '  config:',
    '    probeTimeoutMs: 5000',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const imports = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-doctor', Doctor],
    ...Object.entries(modules),
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!imports.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return imports.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  await Promise.allSettled([...ctx.loader.entries()].map(entry => Promise.resolve(entry.fiber?.await())))
  return ctx
}

/** The doctor reads only the name and config of a shell tool or pi-ai row, so those rows load this inert plugin. */
const inertRow = { name: 'inert-row', apply() {} }

/**
 * Boot the doctor inside a dsh profile: the profile patch, the config editor, and the settings service the web
 * Models page writes through, beside the real local credential store and a dormant `llm-pi-ai` row.
 * @param storedRefs - credential references the local store holds, mapped to their values.
 * @returns the root context once the profile composition settled.
 */
async function bootProfile(storedRefs: Readonly<Record<string, string>>): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-doctor-workspace-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-doctor-profile-'))
  const store = join(home, '.credentials.yaml')
  const refs = Object.entries(storedRefs).map(([ref, value]) => `  ${ref}: ${value}\n`).join('')
  await writeFile(store, `version: 1\nrefs:\n${refs}`, { mode: 0o600 })
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(store)}`,
    '    debounceMs: 10',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    "- name: '@deepseek-ai/dsh-commands'",
    '- id: doctor',
    "  name: '@deepseek-ai/dsh-doctor'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-doctor', Doctor],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await profileComposition(ctx, home, configPath)
  return ctx
}

/** A host where every file check passes, so only the Loader-derived rows vary. */
function quietHost(cwd: string): DoctorEnvironment {
  return {
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v24.0.0',
    harnessVersion: '0.1.6-alpha.2',
    env: { DSH_HOME: cwd },
    exists: () => true,
    writable: () => true,
    readText: () => undefined,
    spawn: () => ({ status: 0, stdout: 'true\n', stderr: '' }),
    launcherPath: () => join(cwd, 'landlock-run'),
    probeLandlock: () => 'full',
    addonBinary: () => join(cwd, 'system.node'),
  }
}

describe('doctor real Loader composition through cordis.yml', () => {
  it('/doctor reads the tools compat rows from the Loader and lists mounted services', async () => {
    const ctx = await boot()
    const cwd = root!
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
    const agent = await ctx.agentLoop.create(SessionId('doctor-loader'), { provider: 'mock', model: 'mock' }, { cwd })
    const signal = new AbortController().signal
    const result = await ctx.commands.find(agent, 'doctor')!.handler({ commandId: CommandId('d'), agent, rawInput: '', attachments: [], signal })
    expect(result.kind).toBe('success')
    const text = (result as { text?: string }).text ?? ''
    expect(text).toContain('argument coercion')
    expect(text).toMatch(/OK +tools +argument coercion/)
    expect(text).toMatch(/OK +tools +nullable parameters/)
    expect(text).toMatch(/OK +plugins +commands/)
    expect(text).toMatch(/WARN +plugins +memory/)
  })

  it('reports each pending and failed Loader row and leaves active and disabled rows out', async () => {
    const ctx = await boot([
      ...COMPAT_TOOLS_ROW,
      '- id: waits',
      "  name: 'waits-for-absent'",
      '- id: off',
      "  name: 'waits-for-absent'",
      '  disabled: true',
      '- id: gate',
      "  name: 'gate'",
      '- id: gated',
      "  name: 'gated-consumer'",
      '- id: breaks',
      "  name: 'breaks'",
    ], {
      'waits-for-absent': { name: 'waits-for-absent', inject: ['absentService'], apply() {} },
      // Provides a service whose availability check refuses every dependent,
      // so the dependent waits although the service is registered.
      gate: { name: 'gate', apply(ctx: Context) { ctx.reflect.provide('gatedService', {}, () => false) } },
      'gated-consumer': { name: 'gated-consumer', inject: ['gatedService'], apply() {} },
      breaks: { name: 'breaks', apply() { throw new Error('breaks on activation') } },
    })
    ctx.doctor.internals = { environment: quietHost(root!) }
    const report = await ctx.doctor.run({ cwd: root! })
    const loaderRows = report.rows.filter(row => row.section === 'plugins' && row.detail !== 'mounted' && row.detail !== 'not mounted')
    expect(loaderRows).toEqual([
      { section: 'plugins', check: 'waits', status: 'warn', detail: 'pending (waiting for absentService)', fix: 'mount the missing service or disable the row' },
      { section: 'plugins', check: 'gated', status: 'warn', detail: 'pending (waiting for a service)', fix: 'mount the missing service or disable the row' },
      { section: 'plugins', check: 'breaks', status: 'fail', detail: 'fiber state failed', fix: 'read the startup log under $DSH_HOME/logs for the activation error' },
    ])
  })

  it('flags compat settings the tools row turns off and each shell tool row that requires a description', async () => {
    const ctx = await boot([
      '- id: tools',
      "  name: '@deepseek-ai/dsh-tools'",
      '  config:',
      '    argumentCoercion: none',
      "- name: '@deepseek-ai/dsh-tool-bash'",
      "- name: '@deepseek-ai/dsh-tool-pwsh'",
      '  config:',
      '    requireDescription: false',
    ], { '@deepseek-ai/dsh-tool-bash': inertRow, '@deepseek-ai/dsh-tool-pwsh': inertRow })
    ctx.doctor.internals = { environment: quietHost(root!) }
    const report = await ctx.doctor.run({ cwd: root! })
    expect(report.rows.filter(row => row.section === 'tools')).toEqual([
      { section: 'tools', check: 'argument coercion', status: 'warn', detail: 'none; GLM/Qwen send numbers as strings', fix: 'set argumentCoercion: lenient on the tools row (dsh-base ships it on)' },
      { section: 'tools', check: 'nullable parameters', status: 'warn', detail: 'oneOf; weak parsers mishandle oneOf', fix: 'set nullableParameters: flat on the tools row (dsh-base ships it on)' },
      { section: 'tools', check: 'tool-bash description', status: 'warn', detail: 'required; models that omit it fail every shell call', fix: 'set requireDescription: false on the tool-bash row and in the agent presets' },
      { section: 'tools', check: 'tool-pwsh description', status: 'ok', detail: 'optional' },
    ])
  })

  it('names the tools defaults a row leaves unset and skips a disabled shell tool row', async () => {
    const ctx = await boot([
      '- id: tools',
      "  name: '@deepseek-ai/dsh-tools'",
      '  config:',
      '    nullableParameters: oneOf',
      "- name: '@deepseek-ai/dsh-tool-bash'",
      '  disabled: true',
    ], { '@deepseek-ai/dsh-tool-bash': inertRow })
    ctx.doctor.internals = { environment: quietHost(root!) }
    const report = await ctx.doctor.run({ cwd: root! })
    expect(report.rows.filter(row => row.section === 'tools').map(row => `${row.check}: ${row.detail}`)).toEqual([
      'argument coercion: none; GLM/Qwen send numbers as strings',
      'nullable parameters: oneOf; weak parsers mishandle oneOf',
    ])
  })

  it('skips a shell tool row an expression disables, as the shipped presets disable the other platform\'s shell', async () => {
    const ctx = await boot([
      "- name: '@deepseek-ai/dsh-tool-pwsh'",
      "  disabled: !!js process.platform !== 'no-such-platform'",
    ], { '@deepseek-ai/dsh-tool-pwsh': inertRow })
    ctx.doctor.internals = { environment: quietHost(root!) }
    const report = await ctx.doctor.run({ cwd: root! })
    expect(report.rows.filter(row => row.section === 'tools').map(row => row.check)).not.toContain('tool-pwsh description')
  })

  it('checks the key reference of each provider on every enabled pi-ai row without reporting a key', async () => {
    const ctx = await boot([
      ...COMPAT_TOOLS_ROW,
      '- id: llm',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      openai:',
      '        apiKeyEnv: DOCTOR_OPENAI_KEY',
      '      ollama: {}',
      '- id: llm-gateway',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      acme-gateway:',
      '        apiKeyEnv: DOCTOR_GATEWAY_KEY',
      '- id: llm-retired',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  disabled: true',
      '  config:',
      '    providers:',
      '      retired:',
      '        apiKeyEnv: DOCTOR_RETIRED_KEY',
    ], { '@deepseek-ai/dsh-llm-pi-ai': inertRow })
    ctx.doctor.internals = { environment: { ...quietHost(root!), env: { DSH_HOME: root!, DOCTOR_OPENAI_KEY: 'sk-doctor-secret' } } }
    const report = await ctx.doctor.run({ cwd: root! })
    expect(report.rows.filter(row => row.section === 'credentials')).toEqual([
      { section: 'credentials', check: 'deepseek-official', status: 'warn', detail: 'DEEPSEEK_API_KEY is not set', fix: 'put DEEPSEEK_API_KEY=... in $DSH_HOME/.env or save the key on the Models page' },
      { section: 'credentials', check: 'openai', status: 'ok', detail: 'DOCTOR_OPENAI_KEY resolves' },
      { section: 'credentials', check: 'acme-gateway', status: 'warn', detail: 'DOCTOR_GATEWAY_KEY is not set', fix: 'put DOCTOR_GATEWAY_KEY=... in $DSH_HOME/.env or save the key on the Models page' },
    ])
    expect(JSON.stringify(report)).not.toContain('sk-doctor-secret')
  })
})

describe('doctor in a dsh profile with the settings service', () => {
  it('checks the key reference of each provider the settings service saves on the llm-pi-ai row', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    vi.stubEnv('DOCTOR_MISSING_KEY', '')
    const ctx = await bootProfile({ DOCTOR_STORED_KEY: 'sk-doctor-stored' })
    ctx.doctor.internals = { environment: quietHost(root!) }
    const deepseekOfficial = { section: 'credentials', check: 'deepseek-official', status: 'warn', detail: 'DEEPSEEK_API_KEY is not set', fix: 'put DEEPSEEK_API_KEY=... in $DSH_HOME/.env or save the key on the Models page' }

    // The shipped posture: the pi-ai row is mounted with no providers yet.
    const dormant = await ctx.doctor.run({ cwd: root! })
    expect(dormant.rows.filter(row => row.section === 'credentials')).toEqual([deepseekOfficial])

    // What the web Models page does when the user adds providers.
    await ctx.settings.update('llm-pi-ai', {
      providers: {
        openai: { apiKeyEnv: 'DOCTOR_STORED_KEY' },
        anthropic: { apiKeyEnv: 'DOCTOR_MISSING_KEY' },
        deepseek: {},
      },
    })
    const report = await ctx.doctor.run({ cwd: root! })
    expect(report.rows.filter(row => row.section === 'credentials')).toEqual([
      deepseekOfficial,
      { section: 'credentials', check: 'openai', status: 'ok', detail: 'DOCTOR_STORED_KEY resolves' },
      { section: 'credentials', check: 'anthropic', status: 'warn', detail: 'DOCTOR_MISSING_KEY is not set', fix: 'put DOCTOR_MISSING_KEY=... in $DSH_HOME/.env or save the key on the Models page' },
    ])
    expect(ctx.doctor.render(report)).toMatch(/^OK +credentials +openai +DOCTOR_STORED_KEY resolves$/m)
    expect(JSON.stringify(report)).not.toContain('sk-doctor-stored')
  })
})
