/**
 * The tool-activity timeline — what ran, when, and for how long.
 *
 * The interface already says WHICH tool is running: one line under the reactor
 * that appears and disappears. What it has never been able to answer is the
 * question you actually ask when an answer takes forty seconds — what has he
 * been doing all this time. That needs history, and history needs a shape.
 *
 * The folding logic lives here rather than in the store so it can be tested
 * without a browser, a React tree or a zustand instance: these are pure
 * functions over an array of records.
 */

export type ToolEvent = {
  id: string
  /** Tool name exactly as the model called it, e.g. `mcp__jarvis__display`. */
  name: string
  /** Epoch milliseconds. */
  startedAt: number
  /** Epoch milliseconds, or null while the tool is still running. */
  endedAt: number | null
}

/**
 * Sixty is about three of the longest answers this thing produces. Past that
 * the rows at the bottom are from a conversation the user has forgotten, and
 * every one of them is a row the component re-measures on every tick.
 */
export const MAX_TOOL_EVENTS = 60

/** Monotonic suffix so two tools starting in the same millisecond differ. */
let seq = 0

/**
 * A tool started.
 *
 * Opening a new event closes whatever was still open: the readout only ever
 * names one active tool, so a second start is also the first one's end. That is
 * an assumption about the caller, not about tools in general — if the bridge
 * ever reports genuine parallelism this is the function that has to change.
 */
export function startTool(
  events: ToolEvent[],
  name: string,
  at: number,
  cap: number = MAX_TOOL_EVENTS,
): ToolEvent[] {
  const trimmed = name.trim()
  if (!trimmed) return events
  const event: ToolEvent = {
    id: `t${at.toString(36)}${(seq++).toString(36)}`,
    name: trimmed,
    startedAt: at,
    endedAt: null,
  }
  // Close any prior active tool before adding this one and enforcing the cap.
  return [...endTools(events, at), event].slice(-cap)
}

/**
 * Nothing is running any more.
 *
 * Called on every clear, including the several redundant ones a single turn
 * fires, so it must return the SAME array when there was nothing open —
 * otherwise every spurious clear re-renders the whole timeline.
 */
export function endTools(events: ToolEvent[], at: number): ToolEvent[] {
  if (!events.some((event) => event.endedAt === null)) return events
  // Stamp only open events and preserve the input array when nothing is running.
  return events.map((event) =>
    event.endedAt === null
      ? { ...event, endedAt: Math.max(at, event.startedAt) }
      : event,
  )
}

/** How long a tool ran, or has been running so far. */
export function toolDuration(event: ToolEvent, now: number): number {
  return Math.max(0, (event.endedAt ?? now) - event.startedAt)
}

/** A duration a person can read at a glance, not a precise one. */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms))
  if (safe < 1000) return `${safe}ms`
  if (safe < 60000) return `${(safe / 1000).toFixed(1)}s`
  const minutes = Math.floor(safe / 60000)
  const seconds = Math.round((safe % 60000) / 1000)
  // 1m 60s is a lie that rounding produces on its own.
  return seconds === 60 ? `${minutes + 1}m 00s` : `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** How long ago something happened, for the right-hand column. */
export function formatAgo(at: number, now: number): string {
  const delta = now - at
  if (delta < 1000) return 'now'
  return `${formatDuration(delta)} ago`
}

export type ToolSpan = {
  event: ToolEvent
  name: string
  /** Display name — the `mcp__server__tool` mangling spelled out. */
  label: string
  duration: number
  durationLabel: string
  agoLabel: string
  running: boolean
  /** Percentages across the visible window, for the bar. */
  offset: number
  width: number
}

/**
 * Strip the MCP prefix off a tool name for display.
 *
 * `mcp__jarvis_chrome__chrome_read_page` is the truth and goes in the title
 * attribute; `chrome read page` is what belongs on a screen someone is reading
 * from across a room.
 */
export function toolLabel(name: string): string {
  const parts = name.split('__')
  const tail = parts.length > 1 ? parts.slice(2).join('__') || parts[1] : name
  return tail.replace(/[_-]+/g, ' ').trim() || name
}

/**
 * Lay the events out across a window that starts at the first one and ends
 * now, newest first.
 *
 * The window is derived from the data rather than fixed: a fixed sixty-second
 * window either squashes a three-minute answer into the right-hand edge or
 * leaves most of the bar empty during a fast one. A minimum span keeps a single
 * 200ms tool from filling the full width and reading as a long wait.
 */
export function toolSpans(events: ToolEvent[], now: number, minSpan = 4000): ToolSpan[] {
  if (!events.length) return []
  const start = Math.min(...events.map((event) => {
    // Anchor the visible time window to the first recorded tool call.
    return event.startedAt
  }))
  const end = Math.max(now, ...events.map((event) => {
    // Running calls extend the window to now; finished calls use their end time.
    return event.endedAt ?? event.startedAt
  }))
  const span = Math.max(end - start, minSpan)
  return events
    .map((event) => {
      // Convert timestamps into bounded bar geometry and readable labels.
      const duration = toolDuration(event, now)
      const offset = ((event.startedAt - start) / span) * 100
      const width = (duration / span) * 100
      return {
        event,
        name: event.name,
        label: toolLabel(event.name),
        duration,
        durationLabel: formatDuration(duration),
        agoLabel: formatAgo(event.startedAt, now),
        running: event.endedAt === null,
        offset: Math.min(100, Math.max(0, offset)),
        width: Math.max(1.5, Math.min(100 - Math.min(100, Math.max(0, offset)), width)),
      }
    })
    .sort((first, second) => {
      // Show the newest tool call first in the panel.
      return second.event.startedAt - first.event.startedAt
    })
}

export type ToolSummary = {
  calls: number
  running: number
  /** Total time spent inside tools, which is not elapsed time. */
  busyMs: number
  busyLabel: string
  /** Distinct tools, most time first. */
  byName: { name: string; label: string; calls: number; busyMs: number }[]
}

/** The header line: how many calls, how much time, which tool dominated. */
export function toolSummary(events: ToolEvent[], now: number): ToolSummary {
  const byName = new Map<string, { name: string; label: string; calls: number; busyMs: number }>()
  let busyMs = 0
  let running = 0
  for (const event of events) {
    const duration = toolDuration(event, now)
    busyMs += duration
    if (event.endedAt === null) running++
    // Aggregate duration and call count under each exact tool name.
    const entry = byName.get(event.name) ?? {
      name: event.name,
      label: toolLabel(event.name),
      calls: 0,
      busyMs: 0,
    }
    entry.calls++
    entry.busyMs += duration
    byName.set(event.name, entry)
  }
  return {
    calls: events.length,
    running,
    busyMs,
    busyLabel: formatDuration(busyMs),
    byName: [...byName.values()].sort((first, second) => {
      // Rank tools by total duration, then by call count.
      return second.busyMs - first.busyMs || second.calls - first.calls
    }),
  }
}
