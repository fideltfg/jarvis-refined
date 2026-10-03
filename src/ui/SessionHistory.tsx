import { useEffect, useState, useSyncExternalStore } from 'react'

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
  const { sessions, currentId } = useSyncExternalStore(sessionHistory.subscribe, sessionHistory.getSnapshot)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null
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
              <li key={session.id}>
                <button
                  type="button"
                  className="sh-session"
                  aria-pressed={session.id === selected?.id}
                  onClick={() => setSelectedId(session.id)}
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
                <span title={sessionTitle(selected)}>{dateTime.format(selected.startedAt)} – {clock.format(selected.updatedAt)}</span>
                {selected.id !== currentId && (
                  <button type="button" className="sh-action" onClick={() => sessionHistory.remove(selected.id)}>Delete</button>
                )}
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
          <button type="button" className="sh-action" onClick={() => sessionHistory.clearPast()}>Clear past sessions</button>
        </footer>
      )}
    </section>
  )

  return inline ? panel : <div className="command-scrim" onClick={toggle}>{panel}</div>
}
