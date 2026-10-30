// Real composition: the workflow engine, its storage, and the journal booted
// from a cordis.yml through the Loader. Only the sandboxed PTC executor is
// substituted — this host cannot always start one — and the subagent runtime's
// working directory is a fixed fixture; everything the journal depends on stays real.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import PtcWorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
import * as WorkflowJournal from '@deepseek-ai/dsh-workflow-journal'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ScriptedRuntime, scriptedProvider } from '../../workflow-ptc/tests/scripted-runtime.ts'

const META = { name: 'audit', description: 'audit the changed files' }

let home: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function boot(): Promise<Context> {
  home = await mkdtemp(join(tmpdir(), 'dsh-workflow-journal-loader-'))
  const configPath = join(home, 'cordis.yml')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    '    mode: read-only',
    "- name: 'test:working-directory'",
    "- name: '@deepseek-ai/dsh-subagent'",
    "- name: 'test:scripted-ptc-runtime'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(home, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-workflow-journal'",
    '  config:',
    '    retainRuns: 50',
    "- name: '@deepseek-ai/dsh-workflow-ptc'",
    '  config:',
    '    provider: stub',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicy],
    ['test:working-directory', { name: 'test-working-directory', apply: (child: Context) => { provideWorkingDirectoryFixture(child, home) } }],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['test:scripted-ptc-runtime', ScriptedRuntime],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-workflow-journal', WorkflowJournal],
    ['@deepseek-ai/dsh-workflow-ptc', PtcWorkflowEngine],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

function fakeParent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId('journal-loader'), { meta: { cwd: ctx.sandboxPolicy.workspaceRoot } })
  const agent = { id: session.id, session, options: {} } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

describe('workflow journal real Loader composition through cordis.yml', () => {
  it('journals a run the engine drove and resumes it without repeating completed work', async () => {
    const ctx = await boot()
    const starts: string[] = []
    ctx.subagents.registerProvider(scriptedProvider({ starts, answers: new Map([['second', 'error']]) }) as never)
    const runtime = ctx.ptcRuntime as ScriptedRuntime
    const parent = fakeParent(ctx)

    runtime.calls = [{ prompt: 'first' }, { prompt: 'second' }]
    const first = ctx.workflowEngine.start({ script: 'return null', meta: META, parent })
    expect((await first.result).stopReason).toBe('completed')
    await first.dispose()
    expect(starts).toEqual(['first', 'second'])

    // The journal records the run without any wiring by the caller.
    const record = ctx.workflowJournal.get(first.id)
    expect(record).toMatchObject({ state: 'done', sessionId: parent.session.id })
    expect(record?.calls.map(call => call.outcome.ok)).toEqual([true, false])

    // Resuming reruns only the call that did not complete.
    starts.length = 0
    const second = ctx.workflowEngine.start({
      script: 'return null', meta: META, parent, resumeRunId: first.id,
    })
    expect((await second.result).stopReason).toBe('completed')
    await second.dispose()
    expect(starts).toEqual(['second'])
    expect(ctx.workflowJournal.get(second.id)?.resumedFrom).toBe(first.id)
  }, 30_000)

  it('/workflows lists the journaled runs and details one', async () => {
    const ctx = await boot()
    ctx.subagents.registerProvider(scriptedProvider({ starts: [], answers: new Map() }) as never)
    const runtime = ctx.ptcRuntime as ScriptedRuntime
    const parent = fakeParent(ctx)
    runtime.calls = [{ prompt: 'only' }]
    const run = ctx.workflowEngine.start({ script: 'return null', meta: META, parent })
    await run.result
    await run.dispose()

    const signal = new AbortController().signal
    const command = ctx.commands.find(parent, 'workflows')!
    const listed = await command.handler({ commandId: CommandId('w1'), agent: parent, rawInput: '', attachments: [], signal })
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain('audit')

    const detailed = await command.handler({ commandId: CommandId('w2'), agent: parent, rawInput: run.id, attachments: [], signal })
    expect(detailed.text).toContain('#1')
    expect(detailed.text).toContain('replayable')
  }, 30_000)

  it('removes the service and the command when the journal fiber is disposed', async () => {
    const ctx = await boot()
    const parent = fakeParent(ctx)
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-workflow-journal')!
    await entry.fiber?.dispose()
    expect(ctx.get('workflowJournal')).toBeUndefined()
    expect(ctx.commands.find(parent, 'workflows')).toBeUndefined()
  }, 30_000)
})
