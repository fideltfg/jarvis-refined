import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./TaskScheduler.tsx', import.meta.url), 'utf8')
const reactor = await readFile(new URL('../../public/themes/lcars/Reactor.tsx', import.meta.url), 'utf8')
const palette = await readFile(new URL('./CommandPalette.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../index.css', import.meta.url), 'utf8')
const lcarsStyles = await readFile(new URL('../../public/themes/lcars/theme.css', import.meta.url), 'utf8')

// Protects shared scheduler layout and its placement in the LCARS command deck.
test('scheduler styling and LCARS docking survive shared stylesheet changes', () => {
  assert.match(styles, /\.task-scheduler \{[^}]*display: flex;[^}]*flex-direction: column;/)
  assert.match(styles, /\.ts-head \{[^}]*display: flex;/)
  assert.match(styles, /\.ts-body \{[^}]*overflow-y: auto;/)
  assert.match(styles, /\.ts-form \{[^}]*border-top: 1px solid var\(--ts-line\);/)
  assert.doesNotMatch(styles, /\.ts-body-editing|\.ts-form \{[^}]*grid-row: 1;/)
  assert.match(styles, /\.ts-tools \{[^}]*grid-template-columns: repeat\(3,/)
  assert.match(styles, /\.ts-action-icons \{[^}]*grid-template-columns: repeat\(4,/)
  const docking = lcarsStyles.match(/\.lcars-deck-history > :is\([^)]*\.task-scheduler-inline[^)]*\) \{([^}]*)\}/)?.[1]
  assert.ok(docking, 'scheduler must share the LCARS command-window docking rules')
  assert.match(docking, /position: absolute;/)
  assert.match(docking, /top: 40px;/)
  assert.match(docking, /bottom: 0;/)
  assert.match(lcarsStyles, /\.task-scheduler-inline \{[^}]*border-left: var\(--lc-window-edge-width\) solid var\(--lc-window-edge\);/)
  assert.match(lcarsStyles, /button:where\(:not\(\.ignition\)\) \{[^}]*box-sizing: border-box;[^}]*border-left: 8px solid var\(--lc-red\) !important;[^}]*border-radius: 0 !important;/)
  assert.match(lcarsStyles, /button:where\(:not\(\.ignition\)\)::before \{[^}]*width: 8px;[^}]*background: #000;/)
  assert.doesNotMatch(lcarsStyles, /\.task-scheduler-inline button(?:::before)? \{/)
})

// Ensures the shared LCARS button treatment has one owner and excludes ignition.
test('LCARS uses one button design across panels and keeps the ignition separate', () => {
  assert.equal((lcarsStyles.match(/border-left: 8px solid var\(--lc-red\) !important;/g) ?? []).length, 1)
  assert.doesNotMatch(lcarsStyles, /\.(?:ab-actions|lcars-deck-actions|lcars-deck-switches|lcars-report-window) button(?::(?:hover|focus-visible|nth-child\(\d+\)|last-child))? \{[^}]*(?:background|border-radius|filter|outline):/)
  assert.match(lcarsStyles, /:is\(button, select\):where\(:not\(\.ignition\)\) \{\s*--lc-button-color: var\(--lc-button-enabled\);\s*--lc-button-text: #000;/)
  assert.match(lcarsStyles, /button:where\(:not\(\.ignition\)\):focus-visible \{[^}]*outline: 2px solid/)
})

// Confirms every theme can reach the scheduler through its normal navigation.
test('scheduler mounts in LCARS and other themes with discoverable navigation', () => {
  assert.match(reactor, /<TaskScheduler inline \/>/)
  assert.match(reactor, /data-command-window="scheduler"/)
  assert.match(palette, /id: 'scheduler'.*setCommandWindow\('scheduler'\)/)
  assert.match(app, /activeTheme\(\).id !== 'lcars' && <TaskScheduler \/>/)
})

// Guards against optimistic writes and unconfirmed schedule deletion.
test('scheduler requires acknowledged mutations and confirms deletion', () => {
  assert.match(source, /await scheduleRequest\(request\)/)
  assert.match(source, /if \(lock.current\) return false/)
  assert.match(source, /window.confirm\(`Delete schedule/)
  assert.match(source, /disabled=\{!online \|\| busy \|\| inFlight/)
  assert.match(source, /role="alert"/)
  assert.match(source, /role=\{inline \? 'region' : 'dialog'\}/)
})

// Ensures schedules persist their own execution choice instead of inheriting chat state.
test('scheduler saves explicit provider/model selections independent of chat', () => {
  assert.match(source, /board\?\.scheduleModels/)
  assert.match(source, /aria-label="Provider"/)
  assert.match(source, /aria-label="Model"/)
  assert.match(source, /priority, trigger, execution/)
  assert.match(source, /priority, execution/)
  assert.match(source, /schedule.execution\.model/)
})

// Keeps an edited schedule form adjacent to the row that owns it.
test('editing a schedule places its form immediately after that task', () => {
  assert.match(source, /<\/article>\s*\{editing !== 'new' && editing\?\.id === schedule\.id && form\}/)
  assert.match(source, /\{editing === 'new' && form\}/)
  assert.doesNotMatch(source, /<div className=\{`ts-body\$\{editing/)
})

// Makes each scheduler action discoverable without relying on icon-only controls.
test('scheduler command buttons show labels beside their icons', () => {
  for (const label of ['Refresh', 'New task', 'Close', 'Board', 'Run', 'Edit', 'Delete', 'Cancel']) {
    assert.ok(source.includes(`/> ${label}</button>`), `missing visible ${label} label`)
  }
})