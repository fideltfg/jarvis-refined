import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicContent, attachmentMeta, describeAttachments, readAttachments, MAX_ATTACHMENTS } from './attachments.ts'

const file = (parts, name, type = '') => new File(parts, name, { type })

test('reads images, PDFs, and untyped text files', async () => {
  const { attachments, rejected } = await readAttachments([
    file(['png'], 'a.png', 'image/png'),
    file(['%PDF-1.7'], 'b.pdf'),
    file(['const x = 1\n'], 'c.ts'),
  ])
  assert.deepEqual(rejected, [])
  assert.deepEqual(attachments.map((a) => a.kind), ['image', 'pdf', 'text'])
  assert.equal(attachments[1].mimeType, 'application/pdf')
  assert.equal(atob(attachments[2].data), 'const x = 1\n')
})

test('rejects binaries and unsupported media but keeps the rest', async () => {
  const { attachments, rejected } = await readAttachments([
    file([new Uint8Array([0, 1, 2])], 'x.bin'),
    file(['abc'], 'clip.mp4', 'video/mp4'),
    file(['ok'], 'ok.txt', 'text/plain'),
  ])
  assert.deepEqual(attachments.map((a) => a.name), ['ok.txt'])
  assert.equal(rejected.length, 2)
})

test('counts files already attached against the limit', async () => {
  const existing = Array.from({ length: MAX_ATTACHMENTS }, () => ({ name: 'n', mimeType: 'text/plain', size: 1, kind: 'text' }))
  const { attachments, rejected } = await readAttachments([file(['x'], 'x.txt')], existing)
  assert.equal(attachments.length, 0)
  assert.match(rejected[0], /at most/)
})

test('builds direct-path content and text history', async () => {
  const { attachments } = await readAttachments([file(['png'], 'a.png', 'image/png'), file(['hi'], 'n.txt')])
  const content = anthropicContent('Explain', attachments)
  assert.deepEqual(content.map((b) => b.type), ['image', 'text', 'text'])
  assert.equal(content[1].text, '<attachment name="n.txt">\nhi\n</attachment>')
  assert.equal(anthropicContent('plain', []), 'plain')
  assert.equal(describeAttachments('', attachments.map(attachmentMeta)), '[Attached: a.png, n.txt]')
  assert.equal('data' in attachmentMeta(attachments[0]), false)
})
