import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AttachmentError,
  MAX_ATTACHMENTS,
  claudeContent,
  describeAttachments,
  isMultimodalRejection,
  parseAttachments,
  pdfText,
  providerContent,
} from './attachments.mjs'

const b64 = (value) => Buffer.from(value).toString('base64')
const PNG = { name: 'shot.png', mimeType: 'image/png', data: b64('\x89PNG fake') }
const PDF = { name: 'doc.pdf', mimeType: 'application/pdf', data: b64('%PDF-1.7 body') }
const NOTE = { name: 'notes.md', mimeType: '', data: b64('# Title\nhello') }

/** A one-page PDF whose text layer reads `text` (or has none when empty). */
function makePdf(text) {
  const stream = text ? `BT /F1 18 Tf 20 50 Td (${text}) Tj ET` : ''
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const at = out.length
    out += `${i + 1} 0 obj\n${object}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return { name: 'real.pdf', mimeType: 'application/pdf', data: b64(out) }
}

const noDescribe = () => { throw new Error('describe should not be called') }

test('no attachments leaves the prompt as plain text', async () => {
  assert.deepEqual(parseAttachments(undefined), [])
  assert.equal(claudeContent('hi', []), 'hi')
  assert.equal(await providerContent('hi', [], { describe: noDescribe }), 'hi')
})

test('classifies images, PDFs, and UTF-8 text', () => {
  const [image, pdf, text] = parseAttachments([PNG, PDF, NOTE])
  assert.equal(image.kind, 'image')
  assert.equal(pdf.kind, 'pdf')
  assert.equal(text.kind, 'text')
  assert.equal(text.text, '# Title\nhello')
})

test('Claude content puts files before the question', () => {
  const content = claudeContent('What is this?', parseAttachments([PNG, PDF, NOTE]))
  assert.deepEqual(content.map((block) => block.type), ['image', 'document', 'text', 'text'])
  assert.equal(content[0].source.media_type, 'image/png')
  assert.equal(content[1].title, 'doc.pdf')
  assert.match(content[2].text, /^<attachment name="notes.md">\n# Title/)
  assert.equal(content[3].text, 'What is this?')
})

test('an attachment-only question has no empty text block', () => {
  const content = claudeContent('  ', parseAttachments([PNG]))
  assert.deepEqual(content.map((block) => block.type), ['image'])
})

test('vision-capable providers get images and PDFs natively', async () => {
  const content = await providerContent('Summarise', parseAttachments([PNG, PDF, NOTE]), { vision: true, nativePdf: true, describe: noDescribe })
  assert.deepEqual(content.map((part) => part.type), ['image_url', 'file', 'text', 'text'])
  assert.equal(content[0].image_url.url, `data:image/png;base64,${PNG.data}`)
  assert.equal(content[1].file.filename, 'doc.pdf')
  assert.match(content[2].text, /<attachment name="notes.md">/)
  assert.equal(content[3].text, 'Summarise')
})

test('text-only models read the PDF text layer', async () => {
  const content = await providerContent('What does it say?', parseAttachments([makePdf('Hello PDF world')]), { describe: noDescribe })
  assert.equal(typeof content, 'string')
  assert.match(content, /<attachment name="real.pdf" note="PDF text layer">\nHello PDF world\n/)
  assert.ok(content.endsWith('What does it say?'))
})

test('text-only models get images and scanned PDFs transcribed', async () => {
  const asked = []
  const describe = async (file) => {
    asked.push(file.name)
    return { by: 'Claude', text: `contents of ${file.name}` }
  }
  const content = await providerContent('', parseAttachments([PNG, makePdf('')]), { describe })
  assert.deepEqual(asked, ['shot.png', 'real.pdf'])
  assert.match(content, /<attachment name="shot.png" note="image transcribed by Claude">\ncontents of shot.png/)
  assert.match(content, /note="PDF transcribed by Claude">\ncontents of real.pdf/)
})

test('PDF text is extracted once and cached', async () => {
  const [file] = parseAttachments([makePdf('Cached')])
  assert.equal(await pdfText(file), 'Cached')
  file.data = ''
  assert.equal(await pdfText(file), 'Cached')
})

test('recognises a model refusing multimodal input', () => {
  assert.ok(isMultimodalRejection({ status: 400, message: 'Multimodal data provided, but model does not support multimodal requests.' }))
  assert.ok(!isMultimodalRejection({ status: 429, message: 'image rate limit' }))
  assert.ok(!isMultimodalRejection({ status: 400, message: 'context length exceeded' }))
})

test('history keeps names, not bytes', () => {
  assert.equal(describeAttachments('look', parseAttachments([PNG])), 'look\n[Attached: shot.png]')
})

test('rejects binary data, fake PDFs, bad base64, and too many files', () => {
  assert.throws(() => parseAttachments([{ name: 'a.bin', mimeType: '', data: b64('a\0b') }]), AttachmentError)
  assert.throws(() => parseAttachments([{ ...PDF, data: b64('nope') }]), AttachmentError)
  assert.throws(() => parseAttachments([{ ...NOTE, data: 'not base64!' }]), AttachmentError)
  assert.throws(() => parseAttachments(Array(MAX_ATTACHMENTS + 1).fill(NOTE)), AttachmentError)
  assert.throws(() => parseAttachments({}), AttachmentError)
})

test('rejects oversized text', () => {
  const big = { name: 'big.txt', mimeType: 'text/plain', data: b64('x'.repeat(512 * 1024 + 1)) }
  assert.throws(() => parseAttachments([big]), /too large/)
})

test('names cannot break out of the attachment wrapper or carry paths', () => {
  const [file] = parseAttachments([{ ...NOTE, name: '../../x"><evil>.md' }])
  assert.equal(file.name, 'x___evil_.md')
})
