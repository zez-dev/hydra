import { describe, expect, it, vi } from 'vitest'
import type { ClientRemote, UsageReportValue } from '@deepseek-ai/dsh-api-remotes/client'
import { usageFace } from '../src/client/face.ts'

const VALUE: UsageReportValue = {
  overall: {
    inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3,
    totalTokens: 17, messages: 1, sessions: 1,
  },
  days: [],
  byModel: [],
}

function face(result: unknown) {
  const report = vi.fn(async () => result)
  return { injected: usageFace({ usage: { report } } as unknown as ClientRemote), report }
}

describe('usageFace', () => {
  it('passes the bounds through and unwraps the Host value', async () => {
    const { injected, report } = face({ ok: true, value: VALUE })
    expect(await injected.report({ since: '2026-09-01' })).toEqual(VALUE)
    expect(report).toHaveBeenCalledWith({ since: '2026-09-01' })
  })

  it('throws the Host business failure with its code and message', async () => {
    const { injected } = face({ ok: false, error: { code: 'internal', message: 'since must be a local calendar day' } })
    await expect(injected.report({ since: 'yesterday' })).rejects.toThrow(
      'usage.report failed: internal: since must be a local calendar day',
    )
  })
})
