/**
 * How alike two notes are, for duplicate detection when a note is stored and
 * when the curator merges: each note becomes its set of meaningful words
 * (stop words dropped, simple endings stripped), and two notes score their
 * word-set overlap (Jaccard), or 1 when the longer note holds every word of a
 * shorter one that has at least four.
 * @module
 */

/**
 * Normalize text for similarity: lowercase, punctuation removed, whitespace collapsed.
 * @param text - entry text.
 * @returns the normalized text.
 */
export function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replaceAll(/[^\p{L}\p{N}\s]+/gu, ' ').replaceAll(/\s+/g, ' ').trim()
}

/** Words too common to tell two notes or a request apart. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has',
  'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'please', 'should',
  'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'this', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
])

/** Endings stripped so a word and its inflections compare equal, longest first. */
const ENDINGS = ['ing', 'ed', 'es', 's'] as const

/** Words a shorter note needs before being wholly contained in a longer one makes them the same note. */
const MIN_CONTAINED_WORDS = 4

/**
 * Reduce one word to the form notes are compared by.
 * @param word - a lowercase word.
 * @returns the word without one simple ending, keeping at least three letters.
 */
function stem(word: string): string {
  for (const ending of ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) return word.slice(0, -ending.length)
  }
  return word
}

/**
 * The meaningful words of a note.
 * @param text - the note text.
 * @returns its stemmed words without stop words or single characters.
 */
export function noteTerms(text: string): Set<string> {
  return new Set(normalizeForSimilarity(text).split(' ')
    .filter(word => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem))
}

/**
 * How alike two notes' word sets are.
 * @param left - one note's {@link noteTerms}.
 * @param right - the other's.
 * @returns a value in [0, 1]; 0 when either is empty.
 */
export function termSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const term of left) if (right.has(term)) shared += 1
  // A longer note that holds every word of a shorter one restates it; one that differs
  // in any word, such as a port number, is a different fact.
  const smaller = Math.min(left.size, right.size)
  return smaller >= MIN_CONTAINED_WORDS && shared === smaller ? 1 : shared / (left.size + right.size - shared)
}

/**
 * Whether two notes are the same note, close enough to merge without a model:
 * similar at or above the threshold, and no word one has and the other lacks
 * carries a digit. Notes that differ in a number (a port, a version, an id)
 * state different facts or a changed value, which takes judgment to resolve.
 * @param left - one note's {@link noteTerms}.
 * @param right - the other's.
 * @param threshold - the similarity two notes must reach.
 * @returns `true` when the notes are the same.
 */
export function isSameNote(left: ReadonlySet<string>, right: ReadonlySet<string>, threshold: number): boolean {
  if (termSimilarity(left, right) < threshold) return false
  for (const term of left) if (!right.has(term) && /\d/u.test(term)) return false
  for (const term of right) if (!left.has(term) && /\d/u.test(term)) return false
  return true
}

/**
 * How alike two notes are.
 * @param a - one note's text.
 * @param b - the other's.
 * @returns a value in [0, 1]; 0 when either has no meaningful word.
 */
export function noteSimilarity(a: string, b: string): number {
  return termSimilarity(noteTerms(a), noteTerms(b))
}
