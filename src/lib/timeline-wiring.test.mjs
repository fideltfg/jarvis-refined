/**
 * The timeline's integration, not its arithmetic — timeline.test.mjs already
 * covers the folding. These tests exist because the feature has been reported
 * finished once before while nothing on screen could reach it: a tested pure
 * module that no component mounts and no button opens is not a feature.
 *
 * Read as source rather than rendered, matching the house style for the UI
 * (see ui/CommandPalette.test.mjs) — there is no DOM in this suite.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createLogger } from 'vite'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

const store = await read('../store.ts')
const app = await read('../App.tsx')
const timeline = await read('../ui/Timeline.tsx')
const launcher = await read('../ui/Launcher.tsx')
const palette = await read('../ui/CommandPalette.tsx')
const styles = await read('../index.css')
const lcars = await read('../../public/themes/lcars/Reactor.tsx')
const lcarsStyles = await read('../../public/themes/lcars/theme.css')

test('the store records tool events off the same call that drives the badge', () => {
  assert.match(store, /import \{ endTools, startTool, type ToolEvent \} from '\.\/lib\/timeline'/)
  assert.match(store, /toolEvents: ToolEvent\[\]/)
  assert.match(store, /timelineOpen: boolean/)
  // One call site, so history cannot drift from the readout.
  assert.match(store, /setActiveTool: \(activeTool\) =>[\s\S]*startTool\(s\.toolEvents, activeTool, at\)[\s\S]*endTools\(s\.toolEvents, at\)/)
  // A re-assertion of the tool already showing must not open a second event.
  assert.match(store, /if \(s\.activeTool === activeTool\) return \{\}/)
  assert.match(store, /toggleTimeline: \(\) => set\(\(s\) => s\.exclusiveCommandWindows[\s\S]*commandWindowState\(s\.timelineOpen \? null : 'timeline'\)[\s\S]*: \{ timelineOpen: !s\.timelineOpen \}/)
})

test('clearing the transcript clears the timeline but clearing panels does not', () => {
  assert.match(store, /const toolEvents = what === 'panels' \? s\.toolEvents : \[\]/)
  assert.match(store, /const cleared = \{ panels, turns, blades, toolEvents,/)
})

test('the timeline component is mounted and reachable by key, button and palette', () => {
  assert.match(app, /import \{ Timeline \} from '\.\/ui\/Timeline'/)
  assert.match(app, /import \{ Launcher \} from '\.\/ui\/Launcher'/)
  assert.match(app, /activeTheme\(\)\.id !== 'lcars' && <Timeline \/>/)
  assert.match(app, /activeTheme\(\)\.id !== 'lcars' && <Launcher \/>/)
  // Shift+T, because bare T is the audio test and has to stay one keypress.
  assert.match(app, /e\.key === 'T' && e\.shiftKey[\s\S]*toggleTimeline\(\)/)
  assert.match(palette, /id: 'timeline'[\s\S]*toggleTimeline\(\)/)
})

test('bare T still runs the audio test', () => {
  assert.match(app, /e\.key === 't' &&[\s\S]*copy\.audioTest/)
})

test('the timeline draws spans from the shared module and runs a clock only when live', () => {
  assert.match(timeline, /import \{ toolSpans, toolSummary \} from '\.\.\/lib\/timeline'/)
  assert.match(timeline, /const running = events\.some\(\(event\) => event\.endedAt === null\)/)
  assert.match(timeline, /if \(!open\) return\s*$/m)
  assert.match(timeline, /if \(!running\) return/)
  assert.match(timeline, /window\.clearInterval\(id\)/)
  // The mangled name stays available, the readable one is on screen.
  assert.match(timeline, /className="tl-name" title=\{span\.name\}/)
  assert.match(timeline, /aria-label="Tool activity timeline"/)
  assert.match(timeline, /No tools have run this session\./)
})

test('the launcher puts the timeline button beside the command palette button', () => {
  assert.match(launcher, /jarvis:toggle-command-palette/)
  assert.match(launcher, /onClick=\{toggleTimeline\}/)
  assert.match(launcher, /aria-pressed=\{timelineOpen\}/)
  // Palette first, timeline second — "next to the command palette button".
  assert.ok(
    launcher.indexOf('toggle-command-palette') < launcher.indexOf('onClick={toggleTimeline}'),
    'the palette button comes first and the timeline button sits next to it',
  )
})

test('LCARS gets the same button next to its palette button, and the panel inline', () => {
  assert.match(lcars, /import \{ Timeline \} from '\.\.\/\.\.\/\.\.\/src\/ui\/Timeline'/)
  assert.match(lcars, /Command palette<\/button>\s*<button[^\n]*onClick=\{toggleTimeline\}[^\n]*Tool timeline/)
  assert.match(lcars, /<CommandPalette inline \/>\s*<Timeline inline \/>/)
  assert.match(lcars, /const toolCalls = useStore\(\(state\) => state\.toolEvents\.length\)/)
})

test('both the floating and inline presentations are styled', () => {
  assert.match(styles, /\.timeline \{[\s\S]*position: absolute;/)
  assert.match(styles, /\.timeline-inline \{[\s\S]*position: static;/)
  assert.match(styles, /\.launcher \{[\s\S]*position: absolute;/)
  assert.match(lcarsStyles, /\[data-theme='lcars'\] \.timeline-inline \{/)
  // A running bar pulses, so reduced motion has to switch it off.
  assert.match(styles, /prefers-reduced-motion: reduce\) \{[\s\S]*\.tl-row\[data-running\] \.tl-bar \{ animation: none; \}/)
})

test('LCARS selects one command window across every pair and shortcut action', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'jarvis-command-windows-'))
  const { phaseColors } = JSON.parse(await read('../../public/themes/lcars/theme.json'))
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let server
  try {
    globalThis.window = {}
    server = await createServer({
      root: fileURLToPath(new URL('../../', import.meta.url)),
      cacheDir,
      plugins: [{
        name: 'store-theme-fixture',
        transform(source, id) {
          if (id === fileURLToPath(new URL('../theme.ts', import.meta.url))) {
            return `export const themePhaseColor = ${JSON.stringify(phaseColors)}`
          }
        },
      }],
      customLogger: createLogger('silent'),
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
    const { useStore } = await server.ssrLoadModule('/src/store.ts')
    useStore.setState({ exclusiveCommandWindows: true })
    const windows = ['agents', 'diagnostics', 'palette', 'scheduler', 'timeline', 'status', 'voice', null]
    const assertWindow = (expected) => {
      const state = useStore.getState()
      assert.equal(state.commandWindow, expected)
      assert.equal(state.boardOpen, expected === 'agents')
      assert.equal(state.timelineOpen, expected === 'timeline')
      assert.equal(state.enrolling, expected === 'voice')
    }
    for (const previous of windows) {
      for (const selected of windows) {
        useStore.getState().setCommandWindow(previous)
        useStore.getState().setCommandWindow(selected)
        assertWindow(selected)
      }
      for (const [action, expected] of [['toggleBoard', 'agents'], ['toggleTimeline', 'timeline']]) {
        useStore.getState().setCommandWindow(previous)
        useStore.getState()[action]()
        assertWindow(previous === expected ? null : expected)
      }
      useStore.getState().setCommandWindow(previous)
      useStore.getState().setEnrolling(true)
      assertWindow('voice')
      useStore.getState().setEnrolling(false)
      assertWindow(null)
    }
    useStore.getState().setCommandWindow('diagnostics')
    useStore.getState().setEnrolling(false)
    assertWindow('diagnostics')
    useStore.getState().setCommandWindow(null)
    useStore.setState({ exclusiveCommandWindows: false })
    useStore.getState().toggleBoard()
    useStore.getState().toggleTimeline()
    useStore.getState().setEnrolling(true)
    assert.equal(useStore.getState().boardOpen, true)
    assert.equal(useStore.getState().timelineOpen, true)
    assert.equal(useStore.getState().enrolling, true)
  } finally {
    await server?.close()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test('LCARS prevents live agents from opening alongside the selected command window', async () => {
  const board = await read('../ui/AgentBoard.tsx')
  assert.match(board, /if \(exclusiveCommandWindows && !open\) return null/)
  assert.match(lcars, /useStore\.setState\(\{ exclusiveCommandWindows: true \}\)/)
  assert.match(lcars, /exclusiveCommandWindows: false/)
  assert.match(lcars, /statusReportOpen = commandWindow === 'status'/)
})

test('approval cards show the requested action details and request time', async () => {
  const board = await read('../ui/AgentBoard.tsx')
  const styles = await read('../index.css')
  assert.match(board, /selected\.approval\.category.*selected\.approval\.action/)
  assert.match(board, /className="ab-approval-detail">\{selected\.approval\.detail\}/)
  assert.match(board, /Requested \{ago\(selected\.approval\.created\)\}/)
  assert.match(styles, /\.ab-approval-detail \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/)
})

test('agent board presents consolidated main-task results instead of worker output', async () => {
  const board = await read('../ui/AgentBoard.tsx')
  assert.match(board, /const filtered = useMemo\(\(\) => needle/)
  assert.match(board, /mainTaskRows\(rows\)/)
  assert.match(board, /selected\.kind === 'goal' && <>[\s\S]*?<TaskResult row=\{selected\}/)
  assert.match(board, /className="ab-main-result" aria-label=\{`Result for \$\{row\.name\}`\}/)
  assert.doesNotMatch(board, /className="ab-result"|<AgentDetails/)
  assert.match(board, /className="ab-task-list"/)
  assert.doesNotMatch(board, /function TaskDocuments/)
  assert.match(board, /<GoalRelatedData tasks=\{selectedTasks\} online=\{online\} \/>/)
  assert.match(board, /DecisionReferenceSection row=\{selected\} online=\{online\}/)
  assert.match(board, /const rosterRows = \[\.\.\.filtered, \.\.\.sessionRows\]/)
  assert.match(board, /label: 'Idle', key: 'idle'/)
})

test('reply fields appear only for live explicit response waits on the combined page', async () => {
  const board = await read('../ui/AgentBoard.tsx')
  assert.match(board, /view === 'agents' && selected\.awaitingResponse && selected\.parentId && !selected\.decisionRequired && !selected\.questions\?\.length && selectedLiveGoal && <AttentionReply/)
  assert.match(board, /view === 'agents' && selected\.awaitingResponse && selectedLiveGoal && <GoalDecisionForm/)
  assert.doesNotMatch(board, /task\.awaitingResponse && online && parent\.awaitingResponse/)
})

test('the agent roster stacks when its panel is narrow, even in a wide viewport', async () => {
  const styles = await read('../index.css')
  const lcars = await read('../../public/themes/lcars/theme.css')
  assert.match(styles, /\.agent-board \{[^}]*container-name: agent-board;[^}]*container-type: inline-size;/)
  assert.match(styles, /@container agent-board \(max-width: 700px\)/)
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\);\s*grid-template-rows: minmax\(120px, 30%\) minmax\(180px, 1fr\)/)
  assert.match(styles, /\.ab-roster-name \{[^}]*word-break: normal;/)
  assert.match(lcars, /@container agent-board \(max-width: 700px\)/)
  assert.match(lcars, /\.agent-board \.ab-workspace \{\s*height: min\(64vh, 640px\);\s*min-height: 320px;/)
  assert.match(styles, /\.ab-roster-row \{ display: grid; grid-template-columns: minmax\(0, 1fr\) max-content; align-items: center; width: 100%; height: 40px; min-height: 40px;/)
  assert.match(lcars, /\.agent-board \.ab-roster-row \{\s*display: grid !important;[\s\S]*?min-height: 40px;\s*height: 40px;/)
  assert.match(lcars, /\.agent-board \.ab-roster-row,[\s\S]*?\.agent-board \.ab-roster-sub \{\s*min-width: 0;/)
})

test('agent roster buttons use the requested state colors', async () => {
  const styles = await read('../index.css')
  const board = await read('../ui/AgentBoard.tsx')
  assert.match(styles, /data-state-group='waiting'\] \{ --ab-state-color: #ff6753;/)
  assert.match(styles, /data-state-group='working'\] \{ --ab-state-color: #e7442a;/)
  assert.match(styles, /data-state-group='paused'\] \{ --ab-state-color: #2a7193;/)
  assert.match(styles, /data-state-group='idle'\] \{ --ab-state-color: #52596e;/)
  assert.match(styles, /data-state-group\]\[data-selected\] \{ border-left-color: #000; background: #858b9f !important;/)
  assert.match(styles, /\.ab-roster-status \{ grid-column: 2; grid-row: 1; align-self: center; justify-self: end;/)
  assert.match(board, /<span className="ab-roster-status">\{statusLabel\(row\.status\)\}<\/span>/)
  assert.match(board, /<span className="ab-roster-copy"><span className="ab-roster-name">\{row\.name\}<\/span>/)
  assert.doesNotMatch(board, /<span className="ab-roster-status ab-chip/)
  assert.doesNotMatch(board, /ab-roster-row[^\n]*ago\(row\.finishedAt|ab-roster-row[^\n]*row\.activity/)
  assert.match(board, /function GoalRelatedData\(/)
  assert.match(board, /<GoalRelatedData tasks=\{tasks\} online=\{online\} \/>/)
  assert.match(board, /<GoalRelatedData tasks=\{relatedTasks\} online=\{online\} \/>/)
  assert.match(board, /className="ab-task-list"/)
  assert.doesNotMatch(board, /function TaskDocuments/)
  assert.match(board, /<GoalRelatedData tasks=\{selectedTasks\} online=\{online\} \/>/)
  assert.match(board, /aria-label="Referenced documents"/)
  assert.match(board, /<h3>Related data<\/h3>/)
  assert.match(board, /className="ab-related-card"/)
  assert.match(board, /references=\{row\.references\} online=\{online\}/)
  assert.match(board, /selected\.decisionRequired && !selected\.questions\?\.length/)
  assert.match(board, /function GoalDecisionForm\(/)
  assert.match(board, /<strong>Approve<\/strong>/)
  assert.match(board, /<strong>Do not approve<\/strong>/)
})
