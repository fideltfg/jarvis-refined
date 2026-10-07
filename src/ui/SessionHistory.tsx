import { useEffect, useSyncExternalStore } from 'react'
import { ListX, Trash2 } from 'lucide-react'

import { sessionTitle, type ChatSession } from '../lib/sessions'
import { useStore } from '../store'
import { copy } from '../theme'
import { AttachmentNames } from './AttachmentTray'
import { sessionHistory } from './sessionHistory'

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })

function sessionMeta(session: ChatSession, currentId: string) {
  const entries = `${session.turns.length} entr${session.turns.length === 1 ? 'y' : 'ies'}`
  return `${dateTime.format(session.startedAt)} · ${entries}${session.id === currentId ? ' · current' : ''}`
}

export function SessionHistory({ inline = false }: { inline?: boolean } = {}) {
  const open = useStore((s) => s.historyOpen)
  const toggle = useStore((s) => s.toggleHistory)
  const phase = useStore((s) => s.phase)
  const loading = useStore((s) => s.sessionLoading)
  const { sessions, currentId } = useSyncExternalStore(sessionHistory.subscribe, sessionHistory.getSnapshot)
  const selected = sessions.find((session) => session.id === currentId) ?? sessions[0] ?? null
  const unavailable = loading || ['offline', 'boot', 'thinking', 'tooling', 'speaking'].includes(phase)
  const hasPast = sessions.some((session) => session.id !== currentId)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Captured first so Escape closes the window instead of standing JARVIS down.
      event.preventDefault()
      event.stopPropagation()
      toggle()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, toggle])

  if (!open) return null

  const panel = (
    <section
      className={`session-history${inline ? ' session-history-inline' : ''}`}
      role={inline ? 'region' : 'dialog'}
      aria-modal={inline ? undefined : true}
      aria-label="Session history"
      onClick={(event) => event.stopPropagation()}
    >
      <header className="sh-head">
        <span>SESSION HISTORY</span>
        <span className="sh-count">{sessions.length.toString().padStart(2, '0')} SESSIONS</span>
        {!inline && <button type="button" className="sh-close" onClick={toggle} aria-label="Close session history">✕</button>}
      </header>

      {sessions.length ? (
        <div className="sh-body">
          <ul className="sh-list" aria-label="Sessions">
            {sessions.map((session) => (
              <li key={session.id} className="sh-session-row">
                <button
                  type="button"
                  className="sh-session"
                  aria-pressed={session.id === currentId}
                  disabled={unavailable}
                  onClick={() => {
                    if (session.id !== currentId) window.dispatchEvent(new CustomEvent('jarvis:reopen-session', { detail: session }))
                  }}
                >
                  <strong>{sessionTitle(session)}</strong>
                  <small>{sessionMeta(session, currentId)}</small>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <div className="sh-detail">
              <div className="sh-detail-head">
                <span className="sh-detail-time" title={sessionTitle(selected)}>{dateTime.format(selected.startedAt)} – {clock.format(selected.updatedAt)}</span>
                <div className="sh-detail-actions">
                  <button type="button" className="sh-action sh-session-delete"
                    title="Delete session"
                    aria-label={`Delete session: ${sessionTitle(selected)}`} disabled={loading || phase === 'offline' || phase === 'boot'}
                    onClick={() => {
                      if (!window.confirm(`Delete session "${sessionTitle(selected)}"? This cannot be undone.`)) return
                      if (selected.id === currentId) {
                        window.dispatchEvent(new CustomEvent('jarvis:delete-session', { detail: selected }))
                      } else {
                        sessionHistory.remove(selected.id)
                      }
                    }}><Trash2 size={14} aria-hidden="true" /> Delete</button>
                </div>
              </div>
              <div className="sh-transcript" role="log" aria-label="Session transcript">
                {selected.turns.map((turn) => (
                  <article key={turn.id} className={`sh-turn sh-turn-${turn.role}`}>
                    <span className="sh-who">{turn.role === 'user' ? 'YOU' : copy.speaker}</span>
                    <time className="sh-time" dateTime={new Date(turn.at).toISOString()}>{clock.format(turn.at)}</time>
                    <div className="sh-text">
                      <p>{turn.text || (turn.attachments?.length ? '' : '…')}</p>
                      <AttachmentNames attachments={turn.attachments} />
                      {turn.tools?.length ? <small className="sh-tools">{turn.tools.join(' · ')}</small> : null}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="sh-empty">No conversations recorded yet.</p>
      )}

      {hasPast && (
        <footer className="sh-foot">
          <span>Stored on this device only.</span>
          <button type="button" className="sh-action" title="Clear past sessions" onClick={() => {
            if (window.confirm('Delete all past sessions? This cannot be undone. The current session will be kept.')) {
              sessionHistory.clearPast()
            }
          }}><ListX size={14} aria-hidden="true" /> Clear past sessions</button>
        </footer>
      )}
    </section>
  )

  return inline ? panel : <div className="command-scrim" onClick={toggle}>{panel}</div>
}
