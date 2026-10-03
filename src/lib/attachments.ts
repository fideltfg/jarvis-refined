/** Files attached to a typed question. Kept dependency-free so node tests can import it directly. */

export type AttachmentKind = 'image' | 'pdf' | 'text'

export type Attachment = {
  name: string
  mimeType: string
  size: number
  kind: AttachmentKind
  /** Base64 of the file bytes. */
  data: string
}

/** What a transcript keeps: the bytes are only needed for the one request. */
export type AttachmentMeta = Pick<Attachment, 'name' | 'mimeType' | 'size' | 'kind'>

// Mirrored in bridge/attachments.mjs, which enforces them.
export const MAX_ATTACHMENTS = 10
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024
export const MAX_BYTES: Record<AttachmentKind, number> = {
  image: 5 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  text: 512 * 1024,
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
type ImageType = (typeof IMAGE_TYPES)[number]
const isImageType = (type: string): type is ImageType => (IMAGE_TYPES as readonly string[]).includes(type)

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Text is whatever decodes as UTF-8 without NULs; source files often arrive with no MIME type. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

function classify(file: File, bytes: Uint8Array): AttachmentKind | null {
  if (isImageType(file.type)) return 'image'
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf'
  if (file.type.startsWith('image/') || file.type.startsWith('audio/') || file.type.startsWith('video/')) return null
  return isText(bytes) ? 'text' : null
}

/**
 * Reads and validates files against what is already attached. Rejections come
 * back as sentences for the UI rather than throwing, so one bad file in a
 * multi-file drop does not discard the rest.
 */
export async function readAttachments(
  files: Iterable<File>,
  existing: readonly AttachmentMeta[] = [],
): Promise<{ attachments: Attachment[]; rejected: string[] }> {
  const attachments: Attachment[] = []
  const rejected: string[] = []
  let count = existing.length
  let total = existing.reduce((sum, item) => sum + item.size, 0)

  for (const file of files) {
    const name = file.name || 'pasted-file'
    if (count >= MAX_ATTACHMENTS) {
      rejected.push(`${name}: at most ${MAX_ATTACHMENTS} files can be attached.`)
      continue
    }
    if (file.size > MAX_BYTES.pdf) {
      rejected.push(`${name}: too large (${formatBytes(file.size)}).`)
      continue
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const kind = classify(file, bytes)
    if (!kind) {
      rejected.push(`${name}: unsupported file type. Attach images, PDFs, or text files.`)
      continue
    }
    if (bytes.length > MAX_BYTES[kind]) {
      rejected.push(`${name}: ${kind} files are limited to ${formatBytes(MAX_BYTES[kind])}.`)
      continue
    }
    if (total + bytes.length > MAX_TOTAL_BYTES) {
      rejected.push(`${name}: attachments are limited to ${formatBytes(MAX_TOTAL_BYTES)} in total.`)
      continue
    }
    const mimeType = kind === 'pdf' ? 'application/pdf' : kind === 'text' ? (file.type || 'text/plain') : file.type
    attachments.push({ name, mimeType, size: bytes.length, kind, data: toBase64(bytes) })
    count += 1
    total += bytes.length
  }
  return { attachments, rejected }
}

export function attachmentMeta({ name, mimeType, size, kind }: Attachment): AttachmentMeta {
  return { name, mimeType, size, kind }
}

function escapeName(name: string): string {
  return name.replace(/[<>"&\r\n]/g, '_')
}

function decodeText(data: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageType; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title: string }

/** Anthropic content blocks for the browser-direct path. The bridge builds its own from the raw files. */
export function anthropicContent(prompt: string, attachments: readonly Attachment[]): string | ContentBlock[] {
  if (!attachments.length) return prompt
  const blocks: ContentBlock[] = attachments.map((file) => {
    if (file.kind === 'image' && isImageType(file.mimeType)) return { type: 'image', source: { type: 'base64', media_type: file.mimeType, data: file.data } }
    if (file.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data }, title: file.name }
    return { type: 'text', text: `<attachment name="${escapeName(file.name)}">\n${decodeText(file.data)}\n</attachment>` }
  })
  if (prompt.trim()) blocks.push({ type: 'text', text: prompt })
  return blocks
}

/** How an attached-file question is remembered in text-only history. */
export function describeAttachments(prompt: string, attachments: readonly AttachmentMeta[]): string {
  if (!attachments.length) return prompt
  const names = attachments.map((file) => file.name).join(', ')
  return `${prompt}${prompt ? '\n' : ''}[Attached: ${names}]`
}
