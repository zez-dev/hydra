// Real composition: the gate booted from a cordis.yml through the Loader
// beside the actual bash tool and its local executor, driven by a scripted
// adapter that calls bash three times. Proves a refused command never reaches
// the shell while the safe ones do, with the files on disk as the evidence.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as CommandGate from '@deepseek-ai/dsh-command-gate'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  const configPath = join(root as string, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    "- name: '@deepseek-ai/dsh-working-directory'",
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-shell-env'",
    "- name: '@deepseek-ai/dsh-bash-local'",
    '  config:',
    '    timeoutMs: 10000',
    '    graceMs: 200',
    "- name: '@deepseek-ai/dsh-tool-bash'",
    "- name: '@deepseek-ai/dsh-command-gate'",
    '  config:',
    '    mode: confirm',
    '    unattendedMode: deny',
    '    allow: []',
    '    denyExtra: []',
    '    temporaryRoots: []',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root as string).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-working-directory', WorkingDirectoryService],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-shell-env', BashEnvPlugin],
    ['@deepseek-ai/dsh-bash-local', LocalBashExecutor],
    ['@deepseek-ai/dsh-tool-bash', ToolBash],
    ['@deepseek-ai/dsh-command-gate', CommandGate],
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

describe('command gate real Loader composition through cordis.yml', () => {
  it('keeps a destructive command out of the shell and lets the safe ones run', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-gate-loader-'))
    // The workspace sits under the platform temporary directory, which stays
    // protected because the workspace is the narrower root.
    const workspace = join(root, 'workspace')
    const scratch = join(root, 'scratch')
    await mkdir(workspace, { recursive: true })
    await mkdir(scratch, { recursive: true })
    await writeFile(join(workspace, 'keepme'), 'x')
    const ctx = await boot()
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'rm -rf keepme', description: 'clean up' }),
      toolCallResponse('call-2', 'bash', { command: 'echo kept > kept.txt', description: 'write a file' }),
      toolCallResponse('call-3', 'bash', { command: `echo note > ${scratch}/note.txt`, description: 'write scratch' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(
      SessionId('command-gate-loader'),
      { provider: 'mock', model: 'mock' },
      { cwd: workspace },
    )
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'tidy up' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const blocked = events.filter(event => event.type === 'command-gate/blocked')
    expect(blocked).toHaveLength(1)
    // No approval service is composed, so the confirm verdict is refused.
    expect(blocked[0]?.data).toMatchObject({ tool: 'bash', command: 'rm -rf keepme', rule: 'rm-destructive', verdict: 'confirm' })

    const results = events.filter(event => event.type === 'tool/result')
    const [refused] = results.map(event => event.data.message.content
      .map(block => block.type === 'text' ? block.text : '').join(''))
    expect(refused).toContain('Command gate: `rm -r`/`-f` in the workspace')
    expect(results.map(event => event.data.message)).toMatchObject([{ isError: true }, { isError: false }, { isError: false }])
    // The refused command never reached a shell, so its target survives.
    expect(await readdir(workspace)).toEqual(expect.arrayContaining(['keepme', 'kept.txt']))
    expect(await readdir(scratch)).toEqual(['note.txt'])
  })
})
