import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FolderJournalStore, parseJournalFile, renderJournalFile, slugify } from '../src/journal.ts'
import type { Journal } from '../src/types.ts'

let root: string | undefined
let store: FolderJournalStore | undefined

afterEach(async () => {
  await store?.close()
  store = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function open(): Promise<FolderJournalStore> {
  root = await mkdtemp(join(tmpdir(), 'dsh-research-'))
  store = new FolderJournalStore(join(root, '.dsh', 'research'))
  await store.open()
  return store
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('slugify', () => {
  it('derives a short lowercase slug from an objective', () => {
    expect(slugify('Prove the Riemann hypothesis for L-functions!')).toBe('prove-the-riemann-hypothesis-for-l-functions')
    expect(slugify('   ')).toBe('research')
    expect(slugify('a'.repeat(120)).length).toBeLessThanOrEqual(60)
  })
})

describe('journal file', () => {
  it('round-trips frontmatter and every section', () => {
    const journal: Journal = {
      slug: 'demo',
      objective: 'Find the optimum',
      criteria: ['error below 1%', 'reproducible twice'],
      status: 'active',
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T11:00:00.000Z',
      sessions: ['s1'],
      breakthroughs: [{ id: 'b-1', at: '2026-09-20T10:30:00.000Z', source: 'model', text: 'Scaling law holds' }],
      hypotheses: [{ id: 'h-1', at: '2026-09-20T10:10:00.000Z', source: 'model', text: 'Depth matters', status: 'open' }],
      experiments: [{ id: 'e-1', at: '2026-09-20T10:20:00.000Z', source: 'auto', what: 'Train 3 layers', result: 'error 4%' }],
      deadEnds: [{ id: 'd-1', at: '2026-09-20T10:40:00.000Z', source: 'human', text: 'Dropout above 0.5' }],
      nextSteps: ['Try 5 layers', 'Sweep the learning rate'],
    }
    const text = renderJournalFile(journal)
    expect(text).toContain('## Breakthroughs')
    expect(text).toContain('- [b-1 2026-09-20T10:30:00.000Z model] Scaling law holds')
    expect(parseJournalFile(text)).toEqual(journal)
  })

  it('rejects a file without frontmatter', () => {
    expect(() => parseJournalFile('# no frontmatter')).toThrow(/frontmatter/u)
  })
})

describe('FolderJournalStore', () => {
  it('creates a journal file and records entries through the API', async () => {
    const s = await open()
    const journal = await s.create({ slug: 'demo', objective: 'Find the optimum', criteria: ['error below 1%'] })
    expect(journal.status).toBe('active')
    const breakthrough = await s.addBreakthrough('demo', 'Scaling law holds', 'model')
    expect(breakthrough.id.startsWith('b-')).toBe(true)
    const hypothesis = await s.addHypothesis('demo', 'Depth matters', 'model')
    await s.setHypothesis('demo', hypothesis.id, 'supported')
    await s.addExperiment('demo', 'Train 3 layers', 'error 4%', 'model')
    await s.addDeadEnd('demo', 'Dropout above 0.5', 'auto')
    await s.setNextSteps('demo', ['Try 5 layers'])
    await s.attachSession('demo', 's1')
    const text = await readFile(join(root!, '.dsh', 'research', 'demo', 'journal.md'), 'utf8')
    expect(text).toContain('Scaling law holds')
    expect(text).toContain('supported] Depth matters')
    const reloaded = parseJournalFile(text)
    expect(reloaded.experiments[0]).toMatchObject({ what: 'Train 3 layers', result: 'error 4%' })
    expect(reloaded.nextSteps).toEqual(['Try 5 layers'])
    expect(reloaded.sessions).toEqual(['s1'])
    expect(s.get('demo')?.breakthroughs).toHaveLength(1)
  })

  it('refuses a duplicate slug and unknown ids', async () => {
    const s = await open()
    await s.create({ slug: 'demo', objective: 'x', criteria: [] })
    await expect(s.create({ slug: 'demo', objective: 'y', criteria: [] })).rejects.toThrow(/already exists/u)
    await expect(s.setHypothesis('demo', 'h-nope', 'refuted')).rejects.toThrow(/no hypothesis/u)
    await expect(s.addBreakthrough('missing', 'x', 'model')).rejects.toThrow(/no research journal/u)
  })

  it('never reloads one of its own earlier writes that the watcher reports after a later one', async () => {
    const s = await open()
    await s.create({ slug: 'demo', objective: 'x', criteria: [] })
    await s.create({ slug: 'sentinel', objective: 'y', criteria: [] })
    const dir = join(root!, '.dsh', 'research')
    const created = await readFile(join(dir, 'demo', 'journal.md'), 'utf8')
    await s.attachSession('demo', 'first')
    // The late read sees the creation's text after the attachment was written.
    await writeFile(join(dir, 'demo', 'journal.md'), created)
    const sentinel = (await readFile(join(dir, 'sentinel', 'journal.md'), 'utf8')).replace('## Next steps\n', '## Next steps\n- Done\n')
    await writeFile(join(dir, 'sentinel', 'journal.md'), sentinel)
    await until(() => (s.get('sentinel')?.nextSteps.length ?? 0) === 1)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(s.get('demo')?.sessions).toEqual(['first'])
  })

  it('picks up an edit made outside the process and reloads on open', async () => {
    const s = await open()
    await s.create({ slug: 'demo', objective: 'x', criteria: [] })
    const changes: string[] = []
    s.onChange(slug => changes.push(slug))
    const path = join(root!, '.dsh', 'research', 'demo', 'journal.md')
    const edited = (await readFile(path, 'utf8')).replace('## Next steps\n', '## Next steps\n- Read the 2019 paper\n')
    await writeFile(path, edited)
    await until(() => (s.get('demo')?.nextSteps.length ?? 0) === 1)
    expect(changes).toContain('demo')
    await s.close()
    const again = new FolderJournalStore(join(root!, '.dsh', 'research'))
    await again.open()
    expect(again.get('demo')?.nextSteps).toEqual(['Read the 2019 paper'])
    await again.close()
  })
})
