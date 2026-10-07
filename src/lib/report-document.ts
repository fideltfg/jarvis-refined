import { marked } from 'marked'

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]!))

export function reportDocumentHtml(file: string, content: string): string {
  const extension = file.split('.').at(-1)?.toLowerCase()
  let body = content
  if (extension === 'md') {
    body = marked.parse(content, { async: false, gfm: true })
  } else if (extension === 'json') {
    try { body = JSON.stringify(JSON.parse(content), null, 2) } catch { /* Keep invalid JSON readable as written. */ }
    body = `<pre><code>${escapeHtml(body)}</code></pre>`
  } else if (extension !== 'html') {
    body = `<pre><code>${escapeHtml(content)}</code></pre>`
  }
  return `<article class="bl-document">${body}</article>`
}