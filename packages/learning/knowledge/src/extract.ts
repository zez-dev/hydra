/**
 * Text extraction for document formats that are not plain text: PDF pages,
 * Word paragraphs, and EPUB chapters become Markdown, keeping page and
 * section headings so passages cite where they came from.
 * @module
 */

import { strFromU8, unzipSync } from 'fflate'
import TurndownService from 'turndown'

/** Extensions read through {@link extractDocument} instead of as text. */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['pdf', 'docx', 'epub'])

/**
 * The document extension of a path, when it names a supported document.
 * @param path - file path.
 * @returns `pdf`, `docx`, `epub`, or `undefined`.
 */
export function documentExtension(path: string): 'pdf' | 'docx' | 'epub' | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const extension = base.slice(base.lastIndexOf('.') + 1)
  return DOCUMENT_EXTENSIONS.has(extension) ? extension as 'pdf' | 'docx' | 'epub' : undefined
}

/** Decode the five XML entities and numeric character references. */
function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
}

/**
 * PDF text, one `## Page N` section per page with its lines in reading order.
 * @param bytes - the file.
 * @returns Markdown text.
 */
async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // pdfjs refuses a Node Buffer and may detach what it receives, so it gets a plain copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  const document = await task.promise
  try {
    const pages: string[] = []
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      let line = ''
      const lines: string[] = []
      for (const item of content.items) {
        if (!('str' in item)) continue
        line += item.str
        if (item.hasEOL) {
          lines.push(line.trimEnd())
          line = ''
        }
      }
      if (line.length > 0) lines.push(line.trimEnd())
      const text = lines.join('\n').trim()
      if (text.length > 0) pages.push(`## Page ${number}\n\n${text}`)
      page.cleanup()
    }
    return pages.join('\n\n')
  } finally {
    await task.destroy()
  }
}

/**
 * Word document paragraphs, `Heading N` styles as Markdown headings.
 * @param bytes - the file.
 * @returns Markdown text.
 */
function extractDocx(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: file => file.name === 'word/document.xml' })
  const xml = files['word/document.xml']
  if (xml === undefined) throw new Error('not a Word document: word/document.xml is missing')
  const out: string[] = []
  for (const match of strFromU8(xml).matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/gu)) {
    const paragraph = match[0]
    const text = decodeXml([...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/gu)]
      .map(run => run[1] ?? (run[0] === '<w:tab/>' ? '\t' : '\n')).join('')).trim()
    if (text.length === 0) continue
    const level = /<w:pStyle w:val="(?:Heading|heading)\s?(\d)"/u.exec(paragraph)?.[1]
    out.push(level === undefined ? text : `${'#'.repeat(Math.min(6, Number(level)))} ${text}`)
  }
  return out.join('\n\n')
}

/**
 * EPUB chapters in reading order, converted from XHTML to Markdown.
 * @param bytes - the file.
 * @returns Markdown text.
 */
function extractEpub(bytes: Uint8Array): string {
  const files = unzipSync(bytes)
  const read = (name: string): string | undefined => {
    const file = files[name]
    return file === undefined ? undefined : strFromU8(file)
  }
  const container = read('META-INF/container.xml')
  const opfPath = container === undefined ? undefined : /full-path="([^"]+)"/u.exec(container)?.[1]
  const opf = opfPath === undefined ? undefined : read(opfPath)
  if (opfPath === undefined || opf === undefined) throw new Error('not an EPUB: the package document is missing')
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const manifest = new Map<string, string>()
  for (const item of opf.matchAll(/<item\s[^>]*>/gu)) {
    const id = /\bid="([^"]+)"/u.exec(item[0])?.[1]
    const href = /\bhref="([^"]+)"/u.exec(item[0])?.[1]
    if (id !== undefined && href !== undefined) manifest.set(id, decodeURIComponent(href))
  }
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  turndown.remove(['script', 'style'])
  const chapters: string[] = []
  for (const ref of opf.matchAll(/<itemref\s[^>]*idref="([^"]+)"/gu)) {
    const href = manifest.get(ref[1] ?? '')
    const xhtml = href === undefined ? undefined : read(`${base}${href}`)
    if (xhtml === undefined) continue
    const body = /<body[^>]*>([\s\S]*)<\/body>/u.exec(xhtml)?.[1] ?? xhtml
    const markdown = turndown.turndown(body).trim()
    if (markdown.length > 0) chapters.push(markdown)
  }
  return chapters.join('\n\n')
}

/**
 * Extract a document's text as Markdown.
 * @param extension - the document format.
 * @param bytes - the file.
 * @returns Markdown text; empty when the document has no text (a scanned PDF).
 * @throws when the file is not a valid document of its format.
 */
export async function extractDocument(extension: 'pdf' | 'docx' | 'epub', bytes: Uint8Array): Promise<string> {
  switch (extension) {
    case 'pdf': return extractPdf(bytes)
    case 'docx': return extractDocx(bytes)
    case 'epub': return extractEpub(bytes)
    default: {
      const unknown: never = extension
      throw new Error(`unsupported document ${String(unknown)}`)
    }
  }
}
