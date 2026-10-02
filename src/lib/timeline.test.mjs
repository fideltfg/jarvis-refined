import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_TOOL_EVENTS,
  endTools,
  formatAgo,
  formatDuration,
  startTool,
  toolDuration,
  toolLabel,
  toolSpans,
  toolSummary,
} from './timeline.ts'

const T0 = 1_760_000_000_000

test('starting a tool opens an event and closes the one before it', () => {
  const first = startTool([], 'mcp__jarvis__display', T0)
  assert.equal(first.length, 1)
  assert.equal(first[0].name, 'mcp__jarvis__display')
  assert.equal(first[0].startedAt, T0)
  assert.equal(first[0].endedAt, null)

  const second = startTool(first, 'WebSearch', T0 + 2000)
  assert.equal(second.length, 2)
  assert.equal(second[0].endedAt, T0 + 2000, 'the first tool ends where the second begins')
  assert.equal(second[1].endedAt, null)
  assert.notEqual(second[0].id, second[1].id)
})

test('two tools in the same millisecond still get distinct ids', () => {
  const events = startTool(startTool([], 'a', T0), 'b', T0)
  assert.notEqual(events[0].id, events[1].id)
})

test('a blank tool name is ignored rather than recorded', () => {
  const events = startTool([], '   ', T0)
  assert.deepEqual(events, [])
})

test('ending tools closes every open event and is a no-op otherwise', () => {
  const open = startTool([], 'Bash', T0)
  const closed = endTools(open, T0 + 500)
  assert.equal(closed[0].endedAt, T0 + 500)
  // Identity, not just equality: redundant clears must not re-render the list.
  assert.equal(endTools(closed, T0 + 900), closed)
  const empty = []
  assert.equal(endTools(empty, T0), empty)
})

test('a clock that steps backwards cannot produce a negative duration', () => {
  const closed = endTools(startTool([], 'Bash', T0), T0 - 5000)
  assert.equal(closed[0].endedAt, T0)
  assert.equal(toolDuration(closed[0], T0), 0)
})

test('a running tool is measured against now', () => {
  const [event] = startTool([], 'Read', T0)
  assert.equal(toolDuration(event, T0 + 1500), 1500)
})

test('the event list is capped at the newest events', () => {
  let events = []
  for (let i = 0; i < MAX_TOOL_EVENTS + 10; i++) events = startTool(events, `tool${i}`, T0 + i * 10)
  assert.equal(events.length, MAX_TOOL_EVENTS)
  assert.equal(events[events.length - 1].name, `tool${MAX_TOOL_EVENTS + 9}`)
  assert.equal(events[0].name, 'tool10')
})

test('durations read the way a person says them', () => {
  assert.equal(formatDuration(0), '0ms')
  assert.equal(formatDuration(420), '420ms')
  assert.equal(formatDuration(1500), '1.5s')
  assert.equal(formatDuration(59_400), '59.4s')
  assert.equal(formatDuration(65_000), '1m 05s')
  assert.equal(formatDuration(119_600), '2m 00s', 'never 1m 60s')
  assert.equal(formatDuration(-10), '0ms')
})

test('ages are relative and collapse to now inside a second', () => {
  assert.equal(formatAgo(T0, T0 + 200), 'now')
  assert.equal(formatAgo(T0, T0 + 4000), '4.0s ago')
})

test('tool labels drop the MCP prefix without losing the name', () => {
  assert.equal(toolLabel('mcp__jarvis__display'), 'display')
  assert.equal(toolLabel('mcp__jarvis_chrome__chrome_read_page'), 'chrome read page')
  assert.equal(toolLabel('WebSearch'), 'WebSearch')
  assert.equal(toolLabel('mcp__jarvis'), 'jarvis')
})

test('spans are newest first and laid out across the window', () => {
  let events = startTool([], 'first', T0)
  events = startTool(events, 'second', T0 + 5000)
  events = endTools(events, T0 + 10_000)
  const spans = toolSpans(events, T0 + 10_000)
  assert.deepEqual(spans.map((span) => span.name), ['second', 'first'])
  const [second, first] = spans
  assert.equal(first.offset, 0)
  assert.equal(first.width, 50)
  assert.equal(second.offset, 50)
  assert.equal(second.width, 50)
  assert.equal(first.durationLabel, '5.0s')
  assert.equal(second.running, false)
})

test('a short lone tool does not fill the whole window', () => {
  const events = endTools(startTool([], 'quick', T0), T0 + 200)
  const [span] = toolSpans(events, T0 + 200)
  assert.ok(span.width < 10, `expected a narrow bar, got ${span.width}`)
  assert.ok(span.width >= 1.5, 'but still wide enough to see')
})

test('a bar never runs past the right edge of the window', () => {
  const events = startTool([], 'running', T0)
  const span = toolSpans(events, T0 + 30_000)[0]
  assert.ok(span.offset + span.width <= 100 + 1e-9)
  assert.equal(span.running, true)
})

test('no events means no spans', () => {
  assert.deepEqual(toolSpans([], T0), [])
})

test('the summary counts calls, busy time and the dominant tool', () => {
  let events = startTool([], 'Bash', T0)
  events = startTool(events, 'Read', T0 + 1000)
  events = endTools(events, T0 + 1500)
  events = startTool(events, 'Bash', T0 + 2000)
  const summary = toolSummary(events, T0 + 12_000)
  assert.equal(summary.calls, 3)
  assert.equal(summary.running, 1)
  assert.equal(summary.busyMs, 1000 + 500 + 10_000)
  assert.equal(summary.busyLabel, '11.5s')
  assert.deepEqual(summary.byName.map((entry) => [entry.name, entry.calls, entry.busyMs]), [
    ['Bash', 2, 11_000],
    ['Read', 1, 500],
  ])
})

test('an empty summary is zeroed rather than undefined', () => {
  const summary = toolSummary([], T0)
  assert.equal(summary.calls, 0)
  assert.equal(summary.running, 0)
  assert.equal(summary.busyLabel, '0ms')
  assert.deepEqual(summary.byName, [])
})
