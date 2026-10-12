import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fuse, KnowledgeIndex, nearest, quantize } from '@deepseek-ai/dsh-knowledge'

let root: string | undefined
let server: Server | undefined
const indexes: KnowledgeIndex[] = []

afterEach(async () => {
  for (const index of indexes.splice(0)) index.close()
  if (server !== undefined) await new Promise(resolve => server!.close(resolve))
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Words that mean the same thing share one dimension; every other word hashes into the rest. */
const CONCEPTS: Record<string, number> = {
  leave: 0, vacation: 0, holiday: 0, pto: 0, deploy: 1, release: 1, ship: 1, rollback: 2, revert: 2, undo: 2,
}
const DIMS = 16

function embedding(text: string): number[] {
  const vector = Array.from({ length: DIMS }, () => 0)
  for (const word of text.toLowerCase().match(/[a-z]+/gu) ?? []) {
    const concept = CONCEPTS[word]
    let sum = 0
    for (let position = 0; position < word.length; position += 1) sum += word.charCodeAt(position)
    const index = concept ?? 3 + (sum % (DIMS - 3))
    vector[index] = (vector[index] ?? 0) + (concept === undefined ? 0.2 : 1)
  }
  return vector
}

/** An OpenAI-compatible /embeddings endpoint; `failing` answers every request with HTTP 500. */
async function endpoint(failing = false): Promise<{ baseURL: string; requests: { input: string[]; dimensions?: number }[] }> {
  const requests: { input: string[]; dimensions?: number }[] = []
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { input: string[]; dimensions?: number }
      requests.push(parsed)
      if (failing) {
        response.writeHead(500).end('down')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: parsed.input.map((text, index) => ({ index, embedding: embedding(text) })) }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests }
}

async function setup(baseURL: string): Promise<{ index: KnowledgeIndex; docs: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-embed-'))
  const docs = join(root, 'docs')
  await mkdir(docs, { recursive: true })
  await writeFile(join(docs, 'time-off.md'), '# Time off\n\nStaff get twenty days of annual leave each year.\n')
  await writeFile(join(docs, 'ops.md'), '# Operations\n\nTo undo a bad deploy, run the revert script.\n')
  const index = await KnowledgeIndex.open({
    path: ':memory:', excludeDirs: [], maxFileBytes: 65536, maxDocumentBytes: 65536,
    bounds: { targetChars: 2400, maxChars: 4800 }, hitChars: 500, maxReadLines: 50,
    embeddings: { baseURL, model: 'mock-embed', dimensions: DIMS, batchSize: 1, timeoutMs: 5000 },
  }, [{ name: 'docs', root: docs }])
  indexes.push(index)
  await index.update()
  return { index, docs }
}

describe('search by meaning', () => {
  it('finds a passage that shares no word with the query once passages are embedded', async () => {
    const { baseURL, requests } = await endpoint()
    const { index } = await setup(baseURL)
    const signal = new AbortController().signal
    expect(index.search({ query: 'holiday', limit: 5 })).toEqual([])
    expect(await index.embedPassages(100, signal)).toEqual({ embedded: 2, failed: 0, remaining: 0 })
    expect(requests.every(request => request.dimensions === DIMS && request.input.length === 1)).toBe(true)
    const { hits, semantic } = await index.searchHybrid({ query: 'holiday', limit: 1 }, signal)
    expect(semantic).toBe(true)
    expect(hits[0]).toMatchObject({ ref: 'docs:time-off.md#L1-L3' })
  })

  it('falls back to the word ranking when the endpoint fails', async () => {
    const good = await endpoint()
    const { index } = await setup(good.baseURL)
    await index.embedPassages(100, new AbortController().signal)
    await new Promise(resolve => server!.close(resolve))
    server = undefined
    const { hits, semantic } = await index.searchHybrid({ query: 'revert script', limit: 3 }, new AbortController().signal)
    expect(semantic).toBe(false)
    expect(hits[0]?.path).toBe('ops.md')
  })

  it('counts failed batches and leaves their passages waiting', async () => {
    const { baseURL } = await endpoint(true)
    const { index } = await setup(baseURL)
    expect(await index.embedPassages(100, new AbortController().signal)).toEqual({ embedded: 0, failed: 2, remaining: 2 })
  })

  it("drops a changed file's vectors with its passages", async () => {
    const { baseURL } = await endpoint()
    const { index, docs } = await setup(baseURL)
    await index.embedPassages(100, new AbortController().signal)
    const file = join(docs, 'ops.md')
    await writeFile(file, '# Operations\n\nShip on Tuesdays.\n')
    const later = new Date(Date.now() + 5000)
    await utimes(file, later, later)
    await index.update()
    expect(index.vectorCount()).toBe(1)
    expect(index.pendingVectorCount()).toBe(1)
  })
})

describe('vector ranking helpers', () => {
  it('ranks by cosine similarity after quantization and fuses rankings by reciprocal rank', () => {
    const query = quantize(Float32Array.from([1, 0, 0]))
    const stored = new Int8Array([
      ...quantize(Float32Array.from([0, 1, 0])), ...quantize(Float32Array.from([2, 0.1, 0])), ...quantize(Float32Array.from([1, 1, 0])),
    ])
    expect(nearest(query, [10, 20, 30], stored, 2)).toEqual([20, 30])
    expect(fuse([[1, 2, 3], [3, 1]])).toEqual([1, 3, 2])
  })
})
