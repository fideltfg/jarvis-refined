import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./TaskScheduler.tsx', import.meta.url), 'utf8')
const reactor = await readFile(new URL('../../public/themes/lcars/Reactor.tsx', import.meta.url), 'utf8')
const palette = await readFile(new URL('./CommandPalette.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../index.css', import.meta.url), 'utf8')
const lcarsStyles = await readFile(new URL('../../public/themes/lcars/theme.css', import.meta.url), 'utf8')

test('scheduler styling and LCARS docking survive shared stylesheet changes', () => {
  assert.match(styles, /\.task-scheduler \{[^}]*display: flex;[^}]*flex-direction: column;/)
  assert.match(styles, /\.ts-head \{[^}]*display: flex;/)
  assert.match(styles, /\.ts-body \{[^}]*overflow-y: auto;/)
  assert.match(styles, /\.ts-body-editing \{[^}]*display: grid;/)
  const docking = lcarsStyles.match(/\.lcars-deck-history > :is\([^)]*\.task-scheduler-inline[^)]*\) \{([^}]*)\}/)?.[1]
  assert.ok(docking, 'scheduler must share the LCARS command-window docking rules')
  assert.match(docking, /position: absolute;/)
  assert.match(docking, /top: 40px;/)
  assert.match(docking, /bottom: 0;/)
  assert.match(lcarsStyles, /\.task-scheduler-inline \{[^}]*border-left: 6px solid var\(--lc-blue\);/)
})

test('scheduler mounts in LCARS and other themes with discoverable navigation', () => {
  assert.match(reactor, /<TaskScheduler inline \/>/)
  assert.match(reactor, /data-command-window="scheduler"/)
  assert.match(palette, /id: 'scheduler'.*setCommandWindow\('scheduler'\)/)
  assert.match(app, /activeTheme\(\).id !== 'lcars' && <TaskScheduler \/>/)
})

test('scheduler requires acknowledged mutations and confirms deletion', () => {
  assert.match(source, /await scheduleRequest\(request\)/)
  assert.match(source, /if \(lock.current\) return false/)
  assert.match(source, /window.confirm\(`Delete schedule/)
  assert.match(source, /disabled=\{!online \|\| busy \|\| inFlight/)
  assert.match(source, /role="alert"/)
  assert.match(source, /role=\{inline \? 'region' : 'dialog'\}/)
})