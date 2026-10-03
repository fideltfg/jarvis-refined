/**
 * Validates files attached to a typed question and turns them into model input.
 * The browser checks the same limits (src/lib/attachments.ts); these are the
 * ones that count, because the socket accepts anything a page sends.
 */

import { extractText, getDocumentProxy } from 'unpdf'

export const MAX_ATTACHMENTS = 10
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024
export const MAX_BYTES = { image: 5 * 1024 * 1024, pdf: 20 * 1024 * 1024, text: 512 * 1024 }
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export class AttachmentError extends Error {}

function cleanName(name) {
  const base = String(name).split(/[\\/]/).pop() ?? ''
  // Control characters, quotes and angle brackets would break the <attachment> wrapper.
  return [...base].map((c) => (c < ' ' || '<>"&'.includes(c) ? '_' : c)).join('').slice(0, 200) || 'attachment'
}

function decodeUtf8(buffer) {
  if (buffer.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

/** Returns normalised attachments, or throws AttachmentError with a sentence fit to show. */
export function parseAttachments(raw) {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new AttachmentError('Attachments must be a list.')
  if (raw.length > MAX_ATTACHMENTS) throw new AttachmentError(`At most ${MAX_ATTACHMENTS} files can be attached.`)

  let total = 0
  return raw.map((item) => {
    if (!item || typeof item.data !== 'string' || !BASE64.test(item.data)) {
      throw new AttachmentError('An attachment could not be read.')
    }
    const name = cleanName(item.name)
    const buffer = Buffer.from(item.data, 'base64')
    total += buffer.length
    if (total > MAX_TOTAL_BYTES) throw new AttachmentError('The attachments are too large in total.')

    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.toLowerCase() : ''
    let file
    if (IMAGE_TYPES.has(mimeType)) {
      file = { name, kind: 'image', mimeType, data: item.data }
    } else if (mimeType === 'application/pdf') {
      if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new AttachmentError(`${name} is not a valid PDF.`)
      file = { name, kind: 'pdf', mimeType, data: item.data }
    } else {
      const text = decodeUtf8(buffer)
      if (text == null) throw new AttachmentError(`${name} is not a supported file type.`)
      file = { name, kind: 'text', mimeType: 'text/plain', text }
    }
    if (buffer.length > MAX_BYTES[file.kind]) throw new AttachmentError(`${name} is too large.`)
    return file
  })
}

const wrapText = (name, text, note = '') =>
  `<attachment name="${name}"${note ? ` note="${note}"` : ''}>\n${text}\n</attachment>`

/** A Claude user message: plain text when nothing is attached, content blocks otherwise. */
export function claudeContent(prompt, attachments) {
  if (!attachments.length) return prompt
  const blocks = attachments.map((file) => {
    if (file.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: file.mimeType, data: file.data } }
    if (file.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data }, title: file.name }
    return { type: 'text', text: wrapText(file.name, file.text) }
  })
  if (prompt.trim()) blocks.push({ type: 'text', text: prompt })
  return blocks
}

const MAX_PDF_CHARS = 200_000

/** The PDF's text layer, cached on the file; empty for scanned pages. */
export async function pdfText(file) {
  if (file.extracted == null) {
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(file.data, 'base64')))
    const { text } = await extractText(pdf, { mergePages: true })
    const trimmed = text.trim()
    file.extracted = trimmed.length > MAX_PDF_CHARS
      ? `${trimmed.slice(0, MAX_PDF_CHARS)}\n[Truncated: the PDF text continues beyond this point.]`
      : trimmed
  }
  return file.extracted
}

/**
 * An OpenAI-compatible user message. Images and PDFs go natively when the model
 * accepts them; otherwise PDFs fall back to their text layer, and anything with
 * no text is transcribed by `describe` (a vision-capable model) so the provider
 * still gets the content rather than a note that it exists.
 */
export async function providerContent(prompt, attachments, { vision = false, nativePdf = false, describe }) {
  if (!attachments.length) return prompt
  const parts = []
  for (const file of attachments) {
    const url = `data:${file.mimeType};base64,${file.data}`
    if (file.kind === 'text') {
      parts.push({ type: 'text', text: wrapText(file.name, file.text) })
    } else if (file.kind === 'image' && vision) {
      parts.push({ type: 'image_url', image_url: { url } })
    } else if (file.kind === 'pdf' && nativePdf) {
      parts.push({ type: 'file', file: { filename: file.name, file_data: url } })
    } else {
      const text = file.kind === 'pdf' ? await pdfText(file) : ''
      if (text) {
        parts.push({ type: 'text', text: wrapText(file.name, text, 'PDF text layer') })
      } else {
        const read = await describe(file)
        parts.push({ type: 'text', text: wrapText(file.name, read.text, `${file.kind === 'pdf' ? 'PDF' : 'image'} transcribed by ${read.by}`) })
      }
    }
  }
  if (prompt.trim()) parts.push({ type: 'text', text: prompt })
  return parts.every((part) => part.type === 'text') ? parts.map((part) => part.text).join('\n\n') : parts
}

/** A 400 from a model that cannot take images or files, as opposed to any other failure. */
export function isMultimodalRejection(err) {
  return err?.status === 400 && /multimodal|image|vision|file/i.test(String(err?.message ?? ''))
}

/** How the question is remembered in history: names only, never the bytes. */
export function describeAttachments(prompt, attachments) {
  if (!attachments.length) return prompt
  return `${prompt}${prompt ? '\n' : ''}[Attached: ${attachments.map((file) => file.name).join(', ')}]`
}
