import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./CommandPalette.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../index.css', import.meta.url), 'utf8')
const reactor = await readFile(new URL('../../public/themes/lcars/Reactor.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8')
const lcarsStyles = await readFile(new URL('../../public/themes/lcars/theme.css', import.meta.url), 'utf8')
const diagnostics = await readFile(new URL('./Diagnostics.tsx', import.meta.url), 'utf8')
const statusReport = await readFile(new URL('../../public/themes/lcars/StatusReport.tsx', import.meta.url), 'utf8')
const timeline = await readFile(new URL('./Timeline.tsx', import.meta.url), 'utf8')
const storeSource = await readFile(new URL('../store.ts', import.meta.url), 'utf8')
const voiceSource = await readFile(new URL('../lib/voice.ts', import.meta.url), 'utf8')
const sessionHistory = await readFile(new URL('./SessionHistory.tsx', import.meta.url), 'utf8')

test('session history keeps deletion on the right of the detail header without a new-session button', () => {
  assert.doesNotMatch(sessionHistory, /MessageSquarePlus|jarvis:new-session|New session/)
  const detailHeader = sessionHistory.match(/<div className="sh-detail-head">[\s\S]*?<div className="sh-transcript"/)?.[0]
  assert.ok(detailHeader)
  assert.match(detailHeader, /className="sh-detail-actions"[\s\S]*className="sh-action sh-session-delete"/)
  assert.match(detailHeader, /<Trash2[^>]*\/> Delete<\/button>/)
  assert.match(styles, /\.sh-session-delete \{[^}]*width: 112px;/)
  assert.match(detailHeader, /sessionHistory.remove\(selected.id\)/)
  assert.doesNotMatch(detailHeader, /disabled=\{[^}]*selected.id === currentId/)
  assert.match(detailHeader, /if \(!window.confirm\([\s\S]*?\)\) return/)
  assert.match(detailHeader, /new CustomEvent\('jarvis:delete-session', \{ detail: selected \}\)/)
  assert.match(app, /reopenHistorySession\(selected\).then\(\(\) => \{[\s\S]*?if \(deleting\) sessionHistory.remove\(deleting.id\)/)
  assert.match(app, /if \(!deleting && store.getState\(\).historyOpen\)/)
  assert.match(app, /addEventListener\('jarvis:delete-session', onReopen\)/)
  assert.match(app, /removeEventListener\('jarvis:delete-session', onReopen\)/)
  assert.doesNotMatch(sessionHistory.split('{selected &&')[0], /sh-session-delete/)
  assert.match(styles, /\.sh-detail-actions \{[^}]*margin-left: auto;/)
})

test('LCARS docks the composer outside the scrolling console and reserves its height', () => {
  assert.match(reactor, /<\/main>\s*<form className="lcars-command-form"/)
  assert.match(lcarsStyles, /\.lcars-reactor \{[^}]*display: grid;[^}]*grid-template-rows: minmax\(0, 1fr\) auto;[^}]*place-items: stretch;/)
  assert.match(lcarsStyles, /\.lcars-reactor-console \{[^}]*position: relative;[^}]*min-height: 0;[^}]*overflow-y: auto;/)
  assert.doesNotMatch(lcarsStyles, /\.lcars-command-form \{[^}]*position: fixed;/)
  assert.match(lcarsStyles, /padding-bottom: env\(safe-area-inset-bottom, 0px\)/)
  assert.doesNotMatch(lcarsStyles, /padding-bottom: (62|66|60|96)px/)
})

test('LCARS shows live speech in the composer without replacing the typed draft', () => {
  assert.match(reactor, /const voiceDraft = useStore\(\(state\) => state.voiceDraft\)/)
  assert.match(reactor, /value=\{voiceDraft \|\| command\}/)
  assert.match(reactor, /readOnly=\{Boolean\(voiceDraft\)\}/)
  assert.match(app, /const onPartial = \(text: string\) => \{[^}]*setVoiceDraft\(text\)/)
  assert.match(app, /setVoiceDraft\(said\)\s*void respond\(said\)/)
  assert.doesNotMatch(app, /const onUtterance = \(text: string\) => \{\s*store.getState\(\).setVoiceDraft\(''\)/)
})

test('LCARS keeps completed speech visible while processing and clears it when the AI responds', () => {
  const setPhaseSource = storeSource.match(/setPhase: \(phase\) => set\(\(state\) => \(\{[\s\S]*?\}\)\),/)?.[0]
  assert.ok(setPhaseSource)
  assert.match(setPhaseSource, /phase === 'listening' && state.phase !== 'listening'/)
  assert.match(setPhaseSource, /phase === 'speaking'/)
  assert.doesNotMatch(setPhaseSource, /phase === '(thinking|tooling)'/)
  assert.match(app, /onText: \(delta\) => \{[\s\S]*?if \(!started\) \{\s*started = true\s*store.getState\(\).setPhase\('speaking'\)/)
})

test('LCARS requests interim recognition even when server transcription is available', () => {
  assert.match(app, /liveTranscription: activeTheme\(\).id === 'lcars'/)
  assert.match(voiceSource, /const useServer = caps\(\).stt && !\(opts.liveTranscription && browserAvailable\)/)
  assert.match(voiceSource, /return useServer \? startServerVoice\(h, diag.ptt\) : startBrowserVoice\(h, diag.ptt\)/)
  assert.match(voiceSource, /rec.interimResults = true/)
})

test('LCARS mounts one non-modal command palette inside the session area', () => {
  assert.match(reactor, /<AgentBoard \/>\s*<CommandPalette inline \/>\s*<Timeline inline \/>\s*<Diagnostics inline \/>/)
  assert.match(app, /activeTheme\(\)\.id !== 'lcars' && <CommandPalette \/>/)
  assert.match(source, /role=\{inline \? 'region' : 'dialog'\}/)
  assert.match(source, /aria-modal=\{inline \? undefined : true\}/)
  assert.match(source, /return inline \? palette :/)
  assert.match(lcarsStyles, /\.command-palette-inline \{[^}]*width: 100%;[^}]*height: auto;[^}]*background: #000/)
  assert.match(lcarsStyles, /\.command-palette-inline \{[^}]*border-left: 6px solid var\(--lc-blue\)/)
  assert.doesNotMatch(source, /Close command palette|<X /)
})

test('LCARS command palette button follows Status report and toggles the palette', () => {
  assert.match(reactor, /Status report<\/button>\s*<button[^\n]*jarvis:toggle-command-palette[^\n]*Command palette<\/button>/)
  assert.match(source, /const toggle = \(\) => setOpen\(\(value\) => !value\)/)
  assert.match(source, /addEventListener\('jarvis:toggle-command-palette', toggle\)/)
  assert.match(source, /removeEventListener\('jarvis:toggle-command-palette', toggle\)/)
})

test('LCARS diagnostics and command palette buttons reflect panel visibility using the shared active style', () => {
  assert.match(reactor, /aria-pressed=\{diagnosticsOpen\}[^\n]*Diagnostics<\/button>/)
  assert.match(reactor, /aria-pressed=\{commandPaletteOpen\}[^\n]*Command palette<\/button>/)
  assert.match(reactor, /const diagnosticsOpen = commandWindow === 'diagnostics'/)
  assert.match(reactor, /const commandPaletteOpen = commandWindow === 'palette'/)
  assert.match(diagnostics, /const open = inline \? commandWindow === 'diagnostics' : localOpen/)
  assert.match(source, /const open = inline \? commandWindow === 'palette' : localOpen/)
  assert.match(lcarsStyles, /\[aria-pressed='true'\][^\n]*\{\s*--lc-button-color: var\(--lc-button-active\)/)
})

test('LCARS colors prioritize error, disabled, selected, active, off, and enabled', () => {
  for (const [state, color] of Object.entries({ off: '#c9ced6', disabled: '#555b65', enabled: '#9edcf2', active: '#00bfff', selected: '#ff6753', error: '#8b1e2d' })) {
    assert.ok(lcarsStyles.includes(`--lc-button-${state}: ${color};`))
  }
  const states = ['off', 'active', 'selected', 'disabled', 'error'].map((state) => lcarsStyles.lastIndexOf(`--lc-button-color: var(--lc-button-${state})`))
  assert.ok(states.every((position, index) => position >= 0 && (!index || position > states[index - 1])))
  assert.match(reactor, /data-function-off=\{!ptt.enabled\} data-function-active=\{ptt.enabled && ptt.held\}/)
  assert.match(reactor, /data-function-off=\{!gestures\}/)
  assert.match(reactor, /data-function-error=\{Boolean\(error\)\}/)
  assert.match(reactor, /document.addEventListener\('click', select, true\)/)
  assert.match(reactor, /control.setAttribute\('data-lcars-selected', 'true'\)/)
  assert.match(reactor, /\[data-command-window="\$\{commandWindow\}"\]/)
})

test('LCARS keeps the full-screen ignition splash black and outside the button palette', () => {
  assert.match(lcarsStyles, /\[data-theme='lcars'\] \.ignition \{\s*background: #000;/)
  assert.match(lcarsStyles, /:is\(button, select\):where\(:not\(\.ignition\)\) \{\s*--lc-button-color:/)
  assert.match(lcarsStyles, /button:where\(:not\(\.ignition\)\) :is\(span, strong, small, b, kbd\)/)
})

test('LCARS status report is a scrollable command window inside the session area, not a modal', () => {
  assert.match(reactor, /<Diagnostics inline \/>\s*\{statusReportOpen && <StatusReport onClose=\{\(\) => setCommandWindow\(null\)\} \/>\}\s*<\/section>/)
  assert.match(statusReport, /className="lcars-report-window" role="region"/)
  assert.doesNotMatch(statusReport, /createPortal|aria-modal|role="dialog"|lcars-report-backdrop|event.key === 'Tab'/)
  assert.match(statusReport, /event.key === 'Escape'/)
  assert.match(lcarsStyles, /\.lcars-report-window \{[^}]*width: 100%;[^}]*height: auto;[^}]*overflow-y: auto;/)
  assert.doesNotMatch(lcarsStyles, /\.lcars-report-backdrop/)
})

test('LCARS command-window headers do not include close buttons', () => {
  assert.doesNotMatch(statusReport, /<button|Close status report|import \{ X \}/)
  assert.match(timeline, /\{!inline && <button[^>]*className="tl-close"/)
  assert.doesNotMatch(source, /Close command palette/)
  assert.doesNotMatch(diagnostics, /<button/)
})

test('all LCARS command windows fill the available session height without individual caps', () => {
  assert.match(lcarsStyles, /\.lcars-deck-body \{[^}]*min-height: 0;/)
  assert.match(lcarsStyles, /\.lcars-deck-history > :is\(\.agent-board, \.command-palette-inline, \.timeline-inline, \.diag, \.lcars-report-window\) \{\s*flex: 1 1 0;\s*height: auto;\s*max-height: none;\s*min-height: 0;/)
  assert.match(lcarsStyles, /height: calc\(100dvh - 140px\)/)
  assert.match(lcarsStyles, /\.lcars-deck-transcript \{\s*flex: 0 1 auto;\s*max-height: min\(18dvh, 160px\);/)
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
