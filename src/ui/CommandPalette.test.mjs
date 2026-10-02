import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./CommandPalette.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../index.css', import.meta.url), 'utf8')
const reactor = await readFile(new URL('../../public/themes/lcars/Reactor.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8')
const lcarsStyles = await readFile(new URL('../../public/themes/lcars/theme.css', import.meta.url), 'utf8')

test('LCARS mounts one non-modal command palette inside the session area', () => {
  assert.match(reactor, /<AgentBoard \/>\s*<CommandPalette inline \/>\s*<Diagnostics inline \/>/)
  assert.match(app, /activeTheme\(\)\.id !== 'lcars' && <CommandPalette \/>/)
  assert.match(source, /role=\{inline \? 'region' : 'dialog'\}/)
  assert.match(source, /aria-modal=\{inline \? undefined : true\}/)
  assert.match(source, /return inline \? palette :/)
  assert.match(lcarsStyles, /\.command-palette-inline \{[^}]*width: 100%;[^}]*height: min\(60vh, 540px\)[^}]*background: #000/)
  assert.match(lcarsStyles, /\.command-palette-inline \{[^}]*border-left: 6px solid var\(--lc-blue\)/)
  assert.doesNotMatch(source, /Close command palette|<X /)
})

test('LCARS command palette button follows Status report and toggles the palette', () => {
  assert.match(reactor, /Status report<\/button>\s*<button[^\n]*jarvis:toggle-command-palette[^\n]*Command palette<\/button>/)
  assert.match(source, /const toggle = \(\) => setOpen\(\(value\) => !value\)/)
  assert.match(source, /addEventListener\('jarvis:toggle-command-palette', toggle\)/)
  assert.match(source, /removeEventListener\('jarvis:toggle-command-palette', toggle\)/)
})

test('command palette provides searchable operational commands and keyboard navigation', () => {
  for (const phrase of ['Toggle agent board', 'Toggle hand controls', 'Toggle diagnostics', 'Clear display', 'Reset interface']) {
    assert.ok(source.includes(phrase), `missing command: ${phrase}`)
  }
  assert.match(source, /ArrowDown/)
  assert.match(source, /ArrowUp/)
  assert.match(source, /aria-activedescendant/)
  assert.match(source, /setQuery\(''\)/)
  assert.match(source, /event\.code === 'Space' && event\.shiftKey/)
})

test('command palette is a themed viewport overlay with a scrollable command list', () => {
  const rule = (selector) => {
    const start = styles.indexOf(`${selector} {`)
    assert.notEqual(start, -1, `missing style: ${selector}`)
    return styles.slice(start, styles.indexOf('}', start) + 1)
  }
  assert.match(rule('.command-scrim'), /position: fixed/)
  assert.match(rule('.command-scrim'), /inset: 0/)
  assert.match(rule('.command-scrim'), /place-items: center/)
  assert.match(rule('.command-palette'), /border: 1px solid var\(--accent/)
  assert.match(rule('.command-palette'), /width: min\(34rem, 100%\)/)
  assert.match(rule('.command-palette'), /max-height: calc\(100dvh - 2rem\)/)
  assert.match(rule('.command-results'), /overflow-y: auto/)
})
