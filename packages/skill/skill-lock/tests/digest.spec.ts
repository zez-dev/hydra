import { describe, expect, it } from 'vitest'
import {
  digestFiles, digestMetadata, parseLockFile, renderLockFile, SkillLockFileError,
} from '@deepseek-ai/dsh-skill-lock'
import type { SkillLockRecord } from '@deepseek-ai/dsh-skill-lock'

const file = (path: string, text: string) => ({ path, content: Buffer.from(text, 'utf8') })

describe('digestFiles', () => {
  it('does not depend on the order the files were read', () => {
    const forward = digestFiles([file('SKILL.md', 'body'), file('ref/a.md', 'a'), file('ref/b.md', 'b')])
    const reverse = digestFiles([file('ref/b.md', 'b'), file('SKILL.md', 'body'), file('ref/a.md', 'a')])
    expect(forward.digest).toBe(reverse.digest)
    expect(forward).toMatchObject({ files: 3, bytes: 6 })
  })

  it('changes when a file body changes', () => {
    const before = digestFiles([file('SKILL.md', 'original')])
    const after = digestFiles([file('SKILL.md', 'edited')])
    expect(after.digest).not.toBe(before.digest)
  })

  it('changes when a file is added, even with identical bodies elsewhere', () => {
    const before = digestFiles([file('SKILL.md', 'body')])
    const after = digestFiles([file('SKILL.md', 'body'), file('extra.md', '')])
    expect(after.digest).not.toBe(before.digest)
    expect(after.files).toBe(2)
  })

  it('changes when a file is renamed but its bytes are not', () => {
    const before = digestFiles([file('ref/a.md', 'same')])
    const after = digestFiles([file('ref/b.md', 'same')])
    expect(after.digest).not.toBe(before.digest)
    expect(after.bytes).toBe(before.bytes)
  })

  it('digests an empty skill to a stable value with no files', () => {
    expect(digestFiles([])).toMatchObject({ files: 0, bytes: 0 })
    expect(digestFiles([]).digest).toBe(digestFiles([]).digest)
  })
})

describe('digestMetadata', () => {
  it('tracks the routing text a virtual skill exposes', () => {
    const base = { name: 'triage', description: 'sort tickets' }
    expect(digestMetadata(base).digest).toBe(digestMetadata({ ...base }).digest)
    expect(digestMetadata({ ...base, description: 'sort issues' }).digest).not.toBe(digestMetadata(base).digest)
    expect(digestMetadata({ ...base, whenToUse: 'after a failure' }).digest).not.toBe(digestMetadata(base).digest)
  })

  it('reports no files, which marks the digest as metadata-only', () => {
    expect(digestMetadata({ name: 'a', description: 'b' }).files).toBe(0)
  })
})

describe('lockfile documents', () => {
  const record: SkillLockRecord = {
    name: 'triage', root: 'project-dsh', digest: 'abc', bytes: 4, files: 1, lockedAt: '2026-09-21T00:00:00.000Z',
  }

  it('renders records sorted by name and ending in a newline', () => {
    const text = renderLockFile([{ ...record, name: 'zeta' }, record])
    expect(text.endsWith('\n')).toBe(true)
    expect(text.indexOf('triage')).toBeLessThan(text.indexOf('zeta'))
  })

  it('round-trips through the parser', () => {
    expect(parseLockFile('/lock.json', renderLockFile([record])).skills).toEqual([record])
  })

  it('keeps an optional source through the round trip', () => {
    const withSource = { ...record, source: 'filesystem' }
    expect(parseLockFile('/lock.json', renderLockFile([withSource])).skills[0]).toEqual(withSource)
  })

  it('reports invalid JSON loudly rather than resetting to an empty lock', () => {
    expect(() => parseLockFile('/lock.json', '{ not json')).toThrow(SkillLockFileError)
    expect(() => parseLockFile('/lock.json', '{ not json')).toThrow(/unreadable/)
  })

  it.each([
    ['a JSON array', '[]', /expected a JSON object/],
    ['a missing version', '{"skills":[]}', /"version": 1/],
    ['a future version', '{"version":2,"skills":[]}', /"version": 1/],
    ['a non-array skills field', '{"version":1,"skills":{}}', /"skills" to be an array/],
    ['a record that is not an object', '{"version":1,"skills":[3]}', /skills\[0\] is not an object/],
    ['a record with no name', '{"version":1,"skills":[{}]}', /name must be a non-empty string/],
    ['a record with a negative byte count', '{"version":1,"skills":[{"name":"a","root":"r","digest":"d","bytes":-1,"files":0,"lockedAt":"t"}]}', /bytes must be a non-negative integer/],
  ])('refuses %s', (_case, text, message) => {
    expect(() => parseLockFile('/lock.json', text)).toThrow(message)
  })
})
