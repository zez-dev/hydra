/** The evidence standard's system-prompt section, pinned verbatim. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as EvidenceGuard from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('evidence standard', () => {
  it('adds the evidence standard to the system prompt only while mounted', async () => {
    const root = new Context()
    ctx = root
    await root.plugin(SystemPrompt, { personaPrefix: '' })
    const mounted = root.plugin(EvidenceGuard)
    await mounted.await()
    const sections = async () => (await root.systemPrompt.assemble()).sections

    expect((await sections()).find(entry => entry.name === 'evidence-standard')?.text).toBe(
      'Read a file in full before you describe or change it, or say which lines you read. '
      + 'Base each claim about files, code, or results on what you read or ran in this session, '
      + 'and cite the file and line or the command output. '
      + 'On long tasks, write each finding in your reply or in a notes file as soon as you find it, not only in your reasoning, '
      + 'because older tool output may be cut later to save context; '
      + 'findings you wrote down from your own reads and commands count as that evidence, '
      + 'so rely on them and re-read only what you need to check again. '
      + 'If you have not verified something, say so instead of guessing. '
      + 'Before your final answer, re-check your claims against that evidence and correct anything wrong.',
    )

    await mounted.dispose()
    expect((await sections()).some(entry => entry.name === 'evidence-standard')).toBe(false)
  })
})
