import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')
const [source, reactor, palette, app, styles, lcars, server] = await Promise.all([
  read('./FileBrowser.tsx'), read('../../public/themes/lcars/Reactor.tsx'), read('./CommandPalette.tsx'),
  read('../App.tsx'), read('../index.css'), read('../../public/themes/lcars/theme.css'), read('../../bridge/server.mjs'),
])

test('file browser is mounted in every theme and reachable from the UI', () => {
  assert.match(app, /<FileBrowser \/>/)
  assert.match(reactor, /<FileBrowser inline \/>/)
  assert.match(reactor, /data-command-window="files"/)
  assert.match(palette, /setCommandWindow\('files'\)/)
  assert.match(source, /filesRequest\(\{ action: 'delete'/)
  assert.match(source, /window\.confirm/)
})

test('file browser styling and LCARS docking exist', () => {
  assert.match(styles, /\.file-browser \{[^}]*flex-direction: column;/)
  assert.match(lcars, /\.lcars-deck-history > :is\([^)]*\.file-browser-inline[^)]*\) \{[^}]*position: absolute;/)
  assert.match(lcars, /\.file-browser-inline \{[^}]*border-left: var\(--lc-window-edge-width\) solid var\(--lc-window-edge\);/)
})

test('bridge serves files only through the confined resolver', () => {
  assert.match(server, /\/files\/raw\?/)
  assert.match(server, /resolveFile\(/)
  assert.match(server, /files_request/)
})
