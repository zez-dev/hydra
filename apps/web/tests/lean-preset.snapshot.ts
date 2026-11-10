/** The lean preset sends the standard prompt and catalog without workflow, plugin management, usage, doctor, or off-peak tools. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/lean-preset', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('lean agent preset', () => {
  let scaffold: WebScaffold | undefined
  let handle: AgentHandle | undefined

  beforeAll(async () => {
    const prompt = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))[0]
    if (prompt === undefined) throw new Error(`${FIXTURE} has no user prompt`)
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: true, paceMs: 10 })
    const web = scaffold
    handle = await web.ctx.agents.create({
      sessionId: SessionId('lean-preset-smoke'),
      meta: { cwd: web.workspaceCwd, agentPreset: 'lean' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => web.ctx.agentPresets.mount(agentCtx, 'lean').then(() => undefined),
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
  })

  // Closing the scaffold compares the persisted Session and the pinned prompt and schema sidecars.
  afterAll(async () => {
    await handle?.dispose()
    await scaffold?.close()
  })

  it('omits the dropped tools, keeps the rest of the standard catalog, and runs bash', () => {
    const session = handle!.agent.session
    const tools = session.requestHeader()?.tools?.map(tool => tool.name) ?? []
    for (const name of ['workflow', 'plugin_manager', 'usage', 'doctor', 'off_peak']) expect(tools).not.toContain(name)
    for (const name of ['bash', 'read', 'edit', 'todo_write', 'schedule_create', 'create_goal', 'subagent', 'subagent_fork']) {
      expect(tools).toContain(name)
    }
    const results = session.snapshotEvents().flatMap(event => event.type === 'tool/result'
      ? [event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
      : [])
    expect(results).toHaveLength(1)
    expect(results[0]).toContain('LEAN_BASH_OK')
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json'])
  })
})
