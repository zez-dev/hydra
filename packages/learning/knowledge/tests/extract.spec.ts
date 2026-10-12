import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { KnowledgeIndex } from '@deepseek-ai/dsh-knowledge'

let root: string | undefined
const indexes: KnowledgeIndex[] = []

afterEach(async () => {
  for (const index of indexes.splice(0)) index.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A one-page PDF whose page shows two lines of text, with a correct cross-reference table. */
function pdf(lines: readonly string[]): Uint8Array {
  const stream = ['BT', '/F1 12 Tf', '72 720 Td', ...lines.flatMap((line, index) => [...index === 0 ? [] : ['0 -16 Td'], `(${line}) Tj`]), 'ET'].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return strToU8(body)
}

/** A Word document with a Heading 1 and a body paragraph. */
function docx(): Uint8Array {
  const paragraph = (text: string, style?: string): string =>
    `<w:p>${style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`}<w:r><w:t>${text}</w:t></w:r></w:p>`
  const document = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paragraph('Expense Policy', 'Heading1')}${paragraph('Receipts over 50 dollars need approval &amp; a scan.')}</w:body></w:document>`
  return zipSync({ 'word/document.xml': strToU8(document), '[Content_Types].xml': strToU8('<Types/>') })
}

/** An EPUB with two chapters in spine order. */
function epub(): Uint8Array {
  const chapter = (title: string, text: string): Uint8Array =>
    strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><style>p{}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`)
  return zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'),
    'OEBPS/book.opf': strToU8([
      '<package><manifest>',
      '<item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>',
      '<item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>',
      '</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
    ].join('')),
    'OEBPS/one.xhtml': chapter('Chapter One', 'Rollback plans start with a snapshot.'),
    'OEBPS/two.xhtml': chapter('Chapter Two', 'Canary releases limit the blast radius.'),
  })
}

async function indexOf(files: Record<string, Uint8Array>, maxDocumentBytes = 1048576): Promise<KnowledgeIndex> {
  root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-docs-'))
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes)
  const index = await KnowledgeIndex.open({
    path: ':memory:', excludeDirs: [], maxFileBytes: 4096, maxDocumentBytes, bounds: { targetChars: 2400, maxChars: 4800 }, hitChars: 1500, maxReadLines: 50,
  }, [{ name: 'books', root }])
  indexes.push(index)
  return index
}

describe('document extraction', () => {
  it('indexes PDF pages, Word headings, and EPUB chapters in reading order, citing their sections', async () => {
    const index = await indexOf({
      'guide.pdf': pdf(['Snapshot the database before a migration.', 'Keep the snapshot for seven days.']),
      'policy.docx': docx(),
      'ops.epub': epub(),
    })
    expect(await index.update()).toMatchObject({ indexed: 3, skipped: 0 })
    expect(index.search({ query: 'snapshot migration', limit: 3 })[0]).toMatchObject({ path: 'guide.pdf', heading: 'Page 1' })
    expect(index.search({ query: 'receipts approval', limit: 3 })[0]).toMatchObject({ path: 'policy.docx', heading: 'Expense Policy' })
    const epubHits = index.search({ query: 'canary releases', limit: 3 })
    expect(epubHits[0]).toMatchObject({ path: 'ops.epub', heading: 'Chapter Two' })
    expect(epubHits[0]?.text).not.toContain('p{}')
  })

  it('reads a document as its extracted text, so refs and line numbers agree', async () => {
    const index = await indexOf({ 'policy.docx': docx() })
    await index.update()
    const [hit] = index.search({ query: 'receipts', limit: 1 })
    const read = await index.read('books', 'policy.docx', hit!.startLine, hit!.endLine)
    expect(read.text).toContain('Receipts over 50 dollars need approval & a scan.')
    expect(read.text.split('\n')[0]).toBe(`${hit!.startLine}: # Expense Policy`)
  })

  it('skips a corrupt document and one above the document size limit', async () => {
    const index = await indexOf({ 'broken.pdf': strToU8('not a pdf'), 'broken.epub': strToU8('not a zip'), 'policy.docx': docx() }, 200)
    expect(await index.update()).toMatchObject({ indexed: 0, skipped: 3 })
  })
})
