/**
 * Search by meaning: passages and queries become vectors from an
 * OpenAI-compatible `/embeddings` endpoint, stored as L2-normalized 8-bit
 * values, and ranked by cosine similarity; the index merges that ranking with
 * the word ranking by reciprocal rank fusion.
 * @module
 */

/** Where and how passages are embedded. */
export interface EmbeddingConfig {
  /** Base URL of an OpenAI-compatible API, such as `http://gpu-box:8000/v1`. */
  readonly baseURL: string
  /** Embedding model id the endpoint serves. */
  readonly model: string
  /** Environment variable holding the API key, when the endpoint needs one. */
  readonly apiKeyEnv?: string
  /** Requested vector size, for models that can shorten their vectors. */
  readonly dimensions?: number
  /** Passages sent per request. */
  readonly batchSize: number
  /** Milliseconds one request may take. */
  readonly timeoutMs: number
}

/**
 * Ask the endpoint for one vector per text.
 * @param config - the endpoint.
 * @param texts - the texts, in order.
 * @param signal - cancellation.
 * @returns one vector per text, in the same order.
 * @throws on an HTTP error, a malformed answer, or a count mismatch.
 */
export async function embedTexts(config: EmbeddingConfig, texts: readonly string[], signal: AbortSignal): Promise<Float32Array[]> {
  const key = config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv]
  const authorization = key === undefined || key.length === 0 ? {} : { authorization: `Bearer ${key}` }
  const response = await fetch(`${config.baseURL.replace(/\/+$/u, '')}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorization },
    body: JSON.stringify({
      model: config.model,
      input: texts,
      ...config.dimensions === undefined ? {} : { dimensions: config.dimensions },
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
  })
  if (!response.ok) throw new Error(`embedding request failed with HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const body = await response.json() as { data?: { index?: number; embedding?: unknown }[] }
  const rows = [...body.data ?? []].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
  if (rows.length !== texts.length) throw new Error(`embedding answer has ${rows.length} vectors for ${texts.length} texts`)
  return rows.map((row) => {
    if (!Array.isArray(row.embedding) || row.embedding.length === 0 || row.embedding.some(value => typeof value !== 'number')) {
      throw new Error('embedding answer has a malformed vector')
    }
    return Float32Array.from(row.embedding as number[])
  })
}

/**
 * Normalize a vector and store it as signed 8-bit values.
 * @param vector - the vector.
 * @returns the quantized unit vector.
 */
export function quantize(vector: Float32Array): Int8Array {
  let norm = 0
  for (const value of vector) norm += value * value
  const scale = norm === 0 ? 0 : 127 / Math.sqrt(norm)
  const out = new Int8Array(vector.length)
  for (let index = 0; index < vector.length; index += 1) {
    out[index] = Math.max(-127, Math.min(127, Math.round((vector[index] ?? 0) * scale)))
  }
  return out
}

/**
 * Rank stored vectors by cosine similarity to a query vector.
 * @param query - the quantized query.
 * @param ids - one id per stored vector.
 * @param vectors - the stored vectors, back to back, `query.length` values each.
 * @param limit - most ids to return.
 * @returns ids, most similar first.
 */
export function nearest(query: Int8Array, ids: readonly number[], vectors: Int8Array, limit: number): number[] {
  const dims = query.length
  const scores: { id: number; score: number }[] = []
  for (let row = 0; row < ids.length; row += 1) {
    let dot = 0
    const offset = row * dims
    for (let index = 0; index < dims; index += 1) dot += (query[index] ?? 0) * (vectors[offset + index] ?? 0)
    const id = ids[row]
    if (id === undefined) continue
    if (scores.length < limit) {
      scores.push({ id, score: dot })
      if (scores.length === limit) scores.sort((left, right) => right.score - left.score)
    } else if (dot > (scores[limit - 1]?.score ?? -Infinity)) {
      scores[limit - 1] = { id, score: dot }
      for (let position = limit - 1; position > 0; position -= 1) {
        const current = scores[position]
        const previous = scores[position - 1]
        if (current === undefined || previous === undefined || current.score <= previous.score) break
        scores[position - 1] = current
        scores[position] = previous
      }
    }
  }
  return scores.sort((left, right) => right.score - left.score).map(entry => entry.id)
}

/**
 * Merge rankings by reciprocal rank fusion: each id scores the sum of `1 / (k + rank)` over the rankings it appears in.
 * @param rankings - id lists, best first.
 * @param k - the fusion constant; 60 is the usual choice.
 * @returns ids, best first.
 */
export function fuse(rankings: readonly (readonly number[])[], k: number = 60): number[] {
  const scores = new Map<number, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)))
  }
  return [...scores].sort((left, right) => right[1] - left[1]).map(([id]) => id)
}
