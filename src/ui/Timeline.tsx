import { useEffect, useMemo, useState } from 'react'

import { useStore } from '../store'
import { toolSpans, toolSummary } from '../lib/timeline'

/**
 * The tool-activity timeline — what ran, when, and for how long.
 *
 * The badge under the reactor says which tool is running right now and then
 * forgets it. This is the other half of that: the history, so "what have you
 * been doing for the last two minutes" has an answer on the screen instead of
 * in a log file. Newest at the top, because the last thing that happened is the
 * thing being asked about.
 *
 * All the folding, labelling and layout maths lives in lib/timeline so it can
 * be tested without a browser. This component only draws rows and runs the
 * clock.
 */

/** Four a second is smooth enough to read as live and cheap enough to ignore. */
const TICK_MS = 250

/** Render recent tool spans and update running durations only while needed. */
export function Timeline({ inline = false }: { inline?: boolean } = {}) {
  const open = useStore((s) => s.timelineOpen)
  const events = useStore((s) => s.toolEvents)
  const toggle = useStore((s) => s.toggleTimeline)
  const [now, setNow] = useState(() => Date.now())

  // The clock only runs while the panel is open AND something is still
  // running. A closed panel ticking in the background is a timer nobody reads,
  // and a finished list does not change — its durations are already final.
  const running = events.some((event) => event.endedAt === null)
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    if (!running) return
    // Refresh visible durations at the chosen low-frequency chart tick.
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [open, running, events.length])

  /** Project raw tool events into ordered timeline spans only while open. */
  const spans = useMemo(() => (open ? toolSpans(events, now) : []), [open, events, now])
  /** Summarize calls and cumulative duration for the open timeline. */
  const summary = useMemo(() => (open ? toolSummary(events, now) : null), [open, events, now])

  if (!open) return null

  return (
    <div
      className={`timeline${inline ? ' timeline-inline' : ''}`}
      role="region"
      aria-label="Tool activity timeline"
    >
      <div className="tl-head">
        <span>TOOL ACTIVITY</span>
        {!inline && <button type="button" className="tl-close" onClick={toggle} aria-label="Close tool activity timeline">
          ✕
        </button>}
      </div>

      {summary && summary.calls > 0 && (
        <div className="tl-summary">
          <span>
            {summary.calls} call{summary.calls === 1 ? '' : 's'} · {summary.busyLabel} in tools
            {summary.running > 0 && ' · running'}
          </span>
          {/* Which tool dominated. Two is enough to tell a story; a full
              breakdown of nine belongs in the log, not over the reactor. */}
          {summary.byName.length > 1 && (
            <span className="tl-tops">
              {summary.byName.slice(0, 2).map((entry) => (
                // Show only the two dominant tools to keep the summary compact.
                <span key={entry.name} className="tl-top" title={entry.name}>
                  {entry.label} ×{entry.calls}
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      {!spans.length && <div className="tl-empty">No tools have run this session.</div>}

      <ul className="tl-list">
        {spans.map((span) => (
          // Render each span in newest-first order with its active duration bar.
          <li key={span.event.id} className="tl-row" data-running={span.running ? '' : undefined}>
            <span className="tl-line">
              {/* The mangled `mcp__server__tool` truth stays in the tooltip;
                  the row shows what a person can read across a room. */}
              <span className="tl-name" title={span.name}>
                {span.label}
              </span>
              <span className="tl-duration">{span.durationLabel}</span>
              <span className="tl-ago">{span.running ? 'running' : span.agoLabel}</span>
            </span>
            <span className="tl-track">
              <span
                className="tl-bar"
                style={{ marginLeft: `${span.offset}%`, width: `${span.width}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
