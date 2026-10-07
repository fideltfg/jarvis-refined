import test from 'node:test'
import assert from 'node:assert/strict'
import { reportDocumentHtml } from './report-document.ts'

test('Markdown documents render headings, tables, lists and code blocks', () => {
  const html = reportDocumentHtml('findings.md', '# Findings\n\n- One\n- Two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1\n```')
  assert.match(html, /<h1>Findings<\/h1>/)
  assert.match(html, /<ul>/)
  assert.match(html, /<table>/)
  assert.match(html, /<pre><code class="language-js">/)
})

test('JSON is indented and plain text is escaped inside code blocks', () => {
  assert.match(reportDocumentHtml('data.json', '{"answer":42}'), /&quot;answer&quot;: 42/)
  assert.match(reportDocumentHtml('notes.txt', '<script>alert(1)</script>'), /&lt;script&gt;/)
})

test('HTML is passed to the blade sanitiser boundary for safe rendering', () => {
  assert.match(reportDocumentHtml('report.html', '<h1>Summary</h1><script>alert(1)</script>'), /<h1>Summary<\/h1><script>/)
})