import { useStore } from '../store'

/**
 * The two things on the screen you can press rather than say.
 *
 * Both the command palette and the tool timeline were keyboard-only, which
 * makes them invisible: a shortcut nobody has been told about is a feature that
 * does not exist. This is the smallest honest fix — a pair of labelled buttons
 * sitting together, each one naming its own key, so the shortcut is learned
 * from the thing it opens.
 *
 * Deliberately not a floating toolbar that grows. Two buttons, bottom right,
 * out of the transcript's way and out of the rails'.
 */
export function Launcher() {
  const toggleTimeline = useStore((s) => s.toggleTimeline)
  const timelineOpen = useStore((s) => s.timelineOpen)
  const calls = useStore((s) => s.toolEvents.length)
  const running = useStore((s) => s.toolEvents.some((event) => event.endedAt === null))

  return (
    <div className="launcher" role="group" aria-label="Interface controls">
      <button
        type="button"
        className="launch-btn"
        onClick={() => window.dispatchEvent(new CustomEvent('jarvis:toggle-command-palette'))}
        title="Open the command palette (Shift+Space)"
      >
        <span aria-hidden="true">⌘</span>
        <span className="launch-label">Commands</span>
        <kbd>⇧␣</kbd>
      </button>
      <button
        type="button"
        className="launch-btn"
        aria-pressed={timelineOpen}
        data-live={running ? '' : undefined}
        onClick={toggleTimeline}
        title="Show what tools have run and for how long (Shift+T)"
      >
        <span aria-hidden="true">⌁</span>
        <span className="launch-label">Timeline</span>
        {/* The count is the reason to press it. With nothing recorded yet the
            shortcut takes the slot rather than a bare zero. */}
        <kbd>{calls ? calls : '⇧T'}</kbd>
      </button>
    </div>
  )
}
