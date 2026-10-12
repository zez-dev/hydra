// Real composition: a base-like stack booted from a cordis.yml through the
// Loader; `/doctor` reads the tools row's compat config from the Loader and
// lists the mounted Hydra services and every Loader row that did not activate.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
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

let root: string | undefined
let home: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, home]) if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  root = undefined
  home = undefined
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

/** The doctor reads only a shell tool row's name and config, so those rows load this inert plugin. */
const inertShellTool = { name: 'inert-shell-tool', apply() {} }

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
    ], { '@deepseek-ai/dsh-tool-bash': inertShellTool, '@deepseek-ai/dsh-tool-pwsh': inertShellTool })
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
    ], { '@deepseek-ai/dsh-tool-bash': inertShellTool })
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
    ], { '@deepseek-ai/dsh-tool-pwsh': inertShellTool })
    ctx.doctor.internals = { environment: quietHost(root!) }
    const report = await ctx.doctor.run({ cwd: root! })
    expect(report.rows.filter(row => row.section === 'tools').map(row => row.check)).not.toContain('tool-pwsh description')
  })
})
