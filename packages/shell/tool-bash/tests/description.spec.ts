import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

const signal = new AbortController().signal
const spillDir = mkdtempSync(join(tmpdir(), 'dsh-tool-bash-description-'))

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
})

async function setup(config: ToolBash.Config = {}) {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
  await ctx.plugin(ToolBash, config)
  return ctx
}

function schemaOf(ctx: Context) {
  return ctx.tools.schemas().find(schema => schema.name === 'bash')!.parameters as { required?: string[] }
}

describe('bash description parameter', () => {
  it('is required by default and a call without it is rejected', async () => {
    const ctx = await setup()
    expect(schemaOf(ctx).required).toContain('description')
    const result = await executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'bash', arguments: { command: 'echo hi' } })
    expect(result.isError).toBe(true)
  })

  it('becomes optional under requireDescription: false and the call runs without it', async () => {
    const ctx = await setup({ requireDescription: false })
    expect(schemaOf(ctx).required).not.toContain('description')
    const result = await executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'bash', arguments: { command: 'echo hi' } })
    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'text' && block.text.includes('hi'))).toBe(true)
  })

  it('presents the command itself when no description was supplied', async () => {
    const ctx = await setup({ requireDescription: false })
    const view = ctx.tools.get('bash')!.presentCall!({ command: 'echo hi' })
    expect(view).toMatchObject({ card: 'terminal', title: 'echo hi', description: 'echo hi' })
  })

  it('shows the command as a background card\'s content when no description was supplied', async () => {
    const ctx = await setup({ requireDescription: false })
    const view = ctx.tools.get('bash')!.presentCall!({ command: 'sleep 5', run_in_background: true })
    expect(view).toEqual({
      card: 'generic',
      title: 'sleep 5',
      kind: 'execute',
      rawInput: 'sleep 5',
      content: [{ type: 'text', text: 'sleep 5' }],
    })
  })
})
