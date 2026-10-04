/** Frames slower than this are a visible hitch, and worth naming. */
const FREEZE_MS = 150
/** Freezes kept on window.__freezes for inspection. */
const FREEZES_KEPT = 20

type LoafScript = {
  invoker?: string
  invokerType?: string
  sourceURL?: string
  sourceFunctionName?: string
  sourceCharPosition?: number
  duration: number
  forcedStyleAndLayoutDuration?: number
}
type LoafEntry = PerformanceEntry & {
  blockingDuration?: number
  renderStart?: number
  styleAndLayoutStart?: number
  scripts?: LoafScript[]
}

export type Freeze = {
  at: string
  ms: number
  /** Time spent in script, versus style, layout and paint. */
  scriptMs: number
  renderMs: number
  /** The slowest scripts in the frame, slowest first. */
  culprits: string[]
}

/**
 * Names the cause of every long frame.
 *
 * "The UI locks up" is not something you can fix from the outside. Chrome's
 * Long Animation Frame entries say which function ran — file, line, and what
 * invoked it — and how much of the frame was rendering instead, so a freeze
 * reported here can be traced to its source rather than guessed at. Falls back
 * to plain long tasks, which give the duration without attribution.
 */
export function startFreezeMonitor(): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {}
  const supported = PerformanceObserver.supportedEntryTypes ?? []
  const type = supported.includes('long-animation-frame') ? 'long-animation-frame'
    : supported.includes('longtask') ? 'longtask' : null
  if (!type) return () => {}

  const kept: Freeze[] = []
  ;(window as unknown as { __freezes: Freeze[] }).__freezes = kept

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as LoafEntry[]) {
      if (entry.duration < FREEZE_MS) continue
      const scripts = [...(entry.scripts ?? [])].sort((a, b) => b.duration - a.duration)
      const scriptMs = scripts.reduce((sum, s) => sum + s.duration, 0)
      const renderMs = entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0
      const freeze: Freeze = {
        at: new Date(performance.timeOrigin + entry.startTime).toLocaleTimeString(),
        ms: Math.round(entry.duration),
        scriptMs: Math.round(scriptMs),
        renderMs: Math.round(renderMs),
        culprits: scripts.slice(0, 3).map((s) => {
          const where = s.sourceURL ? `${s.sourceURL.replace(location.origin, '')}:${s.sourceCharPosition ?? '?'}` : 'unknown source'
          const layout = s.forcedStyleAndLayoutDuration ? `, ${Math.round(s.forcedStyleAndLayoutDuration)}ms forced layout` : ''
          return `${Math.round(s.duration)}ms ${s.sourceFunctionName || '(anonymous)'} @ ${where} via ${s.invokerType ?? '?'} ${s.invoker ?? ''}${layout}`
        }),
      }
      kept.push(freeze)
      if (kept.length > FREEZES_KEPT) kept.shift()
      console.warn(
        `[jarvis] ${freeze.ms}ms freeze — script ${freeze.scriptMs}ms, render ${freeze.renderMs}ms`,
        ...(freeze.culprits.length ? ['\n  ' + freeze.culprits.join('\n  ')] : []),
      )
    }
  })
  observer.observe({ type, buffered: true })
  return () => observer.disconnect()
}

export function startPerformanceCleanup(): () => void {
  // React development profiling retains these measures in the browser's native heap.
  const timer = window.setInterval(() => {
    window.performance.clearMeasures()
  }, 5000)
  return () => window.clearInterval(timer)
}