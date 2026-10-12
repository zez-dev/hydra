// Real composition: the goal stack and the evaluator booted from a cordis.yml
// through the Loader beside the agent loop, driven by scripted model
// responses. Proves that a model `update_goal complete` is denied with the
// evaluator's reasons when the scripted evaluation answers not-yet, and that
// the recorded workspace changes of an earlier turn reach the evaluator.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import CommandRuntime from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as CommandGoal from '@deepseek-ai/dsh-command-goal'
import * as GoalEvaluator from '@deepseek-ai/dsh-goal-evaluator'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceChanges from '@deepseek-ai/dsh-workspace-changes'
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
  root = await mkdtemp(join(tmpdir(), 'dsh-goal-evaluator-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-goal'",
    "- name: '@deepseek-ai/dsh-goal-round-driver'",
    "- name: '@deepseek-ai/dsh-tool-goal'",
    "- name: '@deepseek-ai/dsh-command-goal'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    "- name: '@deepseek-ai/dsh-tool-fs'",
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-workspace-changes'",
    '  config:',
    '    timeoutMs: 5000',
    '    outputMaxBytes: 65536',
    '    maxFiles: 50',
    '    maxFileBytes: 65536',
    '    diffTimeoutMs: 5000',
    "- name: '@deepseek-ai/dsh-goal-evaluator'",
    '  config:',
    '    evidenceEvents: 4',
    '    maxWorkspaceChangeEntries: 3',
    '    maxOutputTokens: 256',
    '    timeoutMs: 5000',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-goal', GoalService],
    ['@deepseek-ai/dsh-goal-round-driver', GoalRoundDriver],
    ['@deepseek-ai/dsh-tool-goal', ToolGoal],
    ['@deepseek-ai/dsh-command-goal', CommandGoal],
    ['@deepseek-ai/dsh-goal-evaluator', GoalEvaluator],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-tool-fs', ToolFs],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-workspace-changes', WorkspaceChanges],
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

describe('goal evaluator real Loader composition through cordis.yml', () => {
  it('denies a model completion when the scripted evaluation says not-yet and keeps the goal active', async () => {
    const ctx = await boot()
    const ref: { current?: { id: string; revision: number } } = {}
    const adapter = new MockAdapter([
      () => toolCallResponse('c1', 'update_goal', { goal_id: ref.current!.id, revision: ref.current!.revision, action: 'complete' }),
      textResponse('{"verdict":"not-yet","reasons":["no test run is recorded","the changed file was never read back"]}'),
      textResponse('understood, continuing'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('goal-evaluator-loader'), { provider: 'mock', model: 'mock' }, { cwd: root! })
    const created = ctx.goals.create(agent, { objective: 'make the tests pass' })
    ref.current = { id: created.id, revision: created.revision }
    // Keep the round driver from queueing continuation rounds during the scripted turn.
    ctx.goals.disarm(agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'finish up' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result).toBeDefined()
    const block = result?.type === 'tool/result' ? result.data.message.content[0] : undefined
    expect(block?.isError).toBe(true)
    const text = block?.content.map(part => part.type === 'text' ? part.text : '').join('') ?? ''
    expect(text).toContain('not yet achieved')
    expect(text).toContain('no test run is recorded')
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', id: created.id })
    expect(adapter.requests[1]).toMatchObject({ purpose: 'goal-evaluate' })
    expect(agent.session.snapshotEvents().some(event => event.type === 'session/goal-evaluation')).toBe(true)
  }, 30_000)

  it('hands the recorded workspace changes of an earlier turn to the evaluator', async () => {
    const ctx = await boot()
    const ref: { current?: { id: string; revision: number } } = {}
    const adapter = new MockAdapter([
      () => toolCallResponse('w1', 'write', { file_path: 'out.txt', content: 'hello\n' }),
      textResponse('written'),
      () => toolCallResponse('c1', 'update_goal', { goal_id: ref.current!.id, revision: ref.current!.revision, action: 'complete' }),
      textResponse('{"verdict":"not-yet","reasons":["out.txt was never read back"]}'),
      textResponse('understood, continuing'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('goal-evaluator-workspace'), { provider: 'mock', model: 'mock' }, { cwd: root! })
    const created = ctx.goals.create(agent, { objective: 'write out.txt' })
    ref.current = { id: created.id, revision: created.revision }
    ctx.goals.disarm(agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'write it' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(await readFile(join(root!, 'out.txt'), 'utf8')).toBe('hello\n')
    expect(agent.session.snapshotEvents().some(event => event.type === 'workspace/changes')).toBe(true)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'finish up' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const evaluation = adapter.requests.find(request => request.purpose === 'goal-evaluate')
    expect(evaluation).toBeDefined()
    const prompt = evaluation!.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n')
    expect(prompt).toContain('Workspace changes recorded in earlier turns')
    expect(prompt).toContain('out.txt')
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active' })
  }, 30_000)
})
