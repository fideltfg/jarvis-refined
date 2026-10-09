import type { AttachmentMeta } from './attachments'

/**
 * Chat session history, kept in localStorage so past conversations survive a
 * reload. A session is one page load's conversation; clearing the transcript
 * closes it and starts the next one.
 */

export type SessionTurn = {
  id: string
  role: 'user' | 'jarvis'
  text: string
  /** When the turn first appeared, epoch ms. */
  at: number
  tools?: string[]
  attachments?: AttachmentMeta[]
}

export type ChatSession = {
  id: string
  conversationId?: string
  startedAt: number
  updatedAt: number
  turns: SessionTurn[]
}

export type SessionSnapshot = {
  sessions: ChatSession[]
  currentId: string
}

type TurnLike = Pick<SessionTurn, 'id' | 'role' | 'text' | 'tools' | 'attachments'>
type TurnSource = {
  getState: () => { turns: TurnLike[] }
  subscribe: (listener: (state: { turns: TurnLike[] }, previous: { turns: TurnLike[] }) => void) => () => void
}

export const STORAGE_KEY = 'jarvis-sessions'
export const MAX_SESSIONS = 50
export const MAX_SESSION_TURNS = 400
const SAVE_DELAY_MS = 1000

/** Accept only persisted turns with the fields required to render a transcript. */
const isTurn = (value: unknown): value is SessionTurn => {
  const turn = value as SessionTurn
  return Boolean(turn) && typeof turn.id === 'string' && (turn.role === 'user' || turn.role === 'jarvis')
    && typeof turn.text === 'string' && typeof turn.at === 'number'
}

/** Validate a stored session's identity, timestamps, and turn collection. */
const isSession = (value: unknown): value is ChatSession => {
  const session = value as ChatSession
  return Boolean(session) && typeof session.id === 'string' && typeof session.startedAt === 'number'
    && typeof session.updatedAt === 'number' && Array.isArray(session.turns)
}

/** Load valid, nonempty sessions newest-first and enforce the storage cap. */
export function loadSessions(): ChatSession[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSession)
      .map((session) => {
        // Keep valid turns while preserving other session metadata.
        return { ...session, turns: session.turns.filter(isTurn) }
      })
      .filter((session) => {
        // Ignore sessions that cannot display any conversation history.
        return session.turns.length > 0
      })
      .sort((first, second) => {
        // Place the most recently updated conversation first.
        return second.updatedAt - first.updatedAt
      })
      .slice(0, MAX_SESSIONS)
  } catch {
    return []
  }
}

/** Writes newest-first; if storage is full, drops the oldest sessions until it fits. */
export function saveSessions(sessions: ChatSession[]): void {
  const keep = sessions.filter((session) => {
    // Empty sessions are represented by the live editor, not saved history.
    return session.turns.length > 0
  })
  try {
    if (!keep.length) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
  } catch {
    return
  }
  for (let count = keep.length; count > 0; count--) {
    try {
      // Retry with one fewer oldest session after quota or storage failures.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keep.slice(0, count)))
      return
    } catch {
      // Storage full or unavailable: retry without the oldest session.
    }
  }
}

/** Merges live turns into a session by id: known turns update in place, new ones append. */
export function recordTurns(session: ChatSession, turns: TurnLike[], now: number): ChatSession {
  const index = new Map(session.turns.map((turn, position) => {
    // Preserve each turn's position so streamed updates replace it in place.
    return [turn.id, position]
  }))
  const next = [...session.turns]
  let changed = false
  for (const turn of turns) {
    const position = index.get(turn.id)
    const existing = position === undefined ? undefined : next[position]
    if (existing && existing.text === turn.text && (existing.tools ?? []).join() === (turn.tools ?? []).join()) continue
    const record: SessionTurn = {
      id: turn.id,
      role: turn.role,
      text: turn.text,
      at: existing?.at ?? now,
      ...(turn.tools?.length && { tools: [...turn.tools] }),
      ...(turn.attachments?.length && {
        attachments: turn.attachments.map(({ name, mimeType, size, kind }) => {
          // Persist display metadata only; attachment bytes remain elsewhere.
          return { name, mimeType, size, kind }
        }),
      }),
    }
    if (position === undefined) {
      index.set(turn.id, next.length)
      next.push(record)
    } else {
      next[position] = record
    }
    changed = true
  }
  if (!changed) return session
  return { ...session, updatedAt: now, turns: next.slice(-MAX_SESSION_TURNS) }
}

/** Replaces or adds a session, newest first, capped. Empty sessions are left out. */
export function upsertSession(sessions: ChatSession[], session: ChatSession): ChatSession[] {
  const others = sessions.filter((entry) => {
    // Replace the matching session instead of keeping duplicate history rows.
    return entry.id !== session.id
  })
  if (!session.turns.length) return others
  return [session, ...others].sort((first, second) => {
    // Keep the returned list ordered for history navigation.
    return second.updatedAt - first.updatedAt
  }).slice(0, MAX_SESSIONS)
}

/** Derive a compact title from the first nonempty user turn or transcript text. */
export function sessionTitle(session: ChatSession): string {
  const first = session.turns.find((turn) => {
    // Prefer a user's opening request for the history label.
    return turn.role === 'user' && turn.text.trim()
  }) ?? session.turns.find((turn) => {
    // Fall back to the first readable turn if no user text was saved.
    return turn.text.trim()
  })
  const text = first?.text.trim().replace(/\s+/g, ' ') ?? ''
  if (!text) return 'Untitled session'
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

/** Restore the active session, linked checkpoint, or most recent history entry. */
export function startupSession(
  sessions: ChatSession[],
  { activeId, conversationId }: { activeId?: string | null; conversationId?: string } = {},
): ChatSession | null {
  if (activeId) return sessions.find((session) => {
    // An explicit empty active id intentionally prevents restoring old history.
    return session.id === activeId
  }) ?? null
  const linked = conversationId && sessions.find((session) => {
    // Prefer the session whose bridge checkpoint matches this browser tab.
    return session.conversationId === conversationId
  })
  return linked || [...sessions].sort((first, second) => {
    // With no active or linked session, choose the most recently updated one.
    return second.updatedAt - first.updatedAt
  })[0] || null
}

/** Create an empty session with stable timestamps and a per-session id. */
const newSession = (now: number): ChatSession => ({
  id: `s-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  startedAt: now,
  updatedAt: now,
  turns: [],
})

/**
 * Records the store's turns into the current session and persists them.
 * Saves are debounced because streamed answers update the last turn per token.
 */
export function createSessionHistory(
  source: TurnSource,
  { now = Date.now, delay = SAVE_DELAY_MS, onSave }: { now?: () => number; delay?: number; onSave?: (sessions: ChatSession[]) => void } = {},
) {
  let sessions = loadSessions()
  let current = recordTurns(newSession(now()), source.getState().turns, now())
  let snapshot: SessionSnapshot = { sessions: upsertSession(sessions, current), currentId: current.id }
  let timer: ReturnType<typeof setTimeout> | null = null
  let changingSession = false
  const listeners = new Set<() => void>()

  /** Refresh the public snapshot and notify history-view subscribers. */
  const publish = () => {
    snapshot = { sessions: upsertSession(sessions, current), currentId: current.id }
    // Subscribers read the new immutable snapshot through getSnapshot().
    listeners.forEach((listener) => listener())
  }
  /** Persist current turns and merge other tabs' latest history first. */
  const flush = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    // Re-read so other tabs' sessions and deletions are not overwritten.
    sessions = upsertSession(loadSessions(), current)
    saveSessions(sessions)
    onSave?.(sessions)
  }
  /** Schedule one delayed save for a burst of streamed store updates. */
  const schedule = () => {
    if (timer === null) timer = setTimeout(flush, delay)
  }

  // Record meaningful store changes while ignoring updates caused by reopen/startNew.
  const unsubscribe = source.subscribe((state, previous) => {
    if (changingSession) return
    if (state.turns === previous.turns) return
    if (!state.turns.length && previous.turns.length) {
      flush()
      current = newSession(now())
      publish()
      return
    }
    const next = recordTurns(current, state.turns, now())
    if (next === current) return
    current = next
    publish()
    schedule()
  })

  return {
    /** Return the latest immutable history snapshot. */
    getSnapshot: () => snapshot,
    /** Add a listener for session-list and active-session changes. */
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      // Return the matching unsubscribe operation to the subscriber.
      return () => { listeners.delete(listener) }
    },
    /** Link the live session to the bridge's durable conversation checkpoint. */
    attachConversation: (conversationId: string) => {
      if (current.conversationId === conversationId) return
      current = { ...current, conversationId }
      publish()
      flush()
    },
    /** Switch to saved turns while suppressing the store's echo subscription. */
    reopen: (id: string, showTurns: (turns: SessionTurn[]) => void) => {
      flush()
      const selected = sessions.find((session) => session.id === id)
      if (!selected) return false
      current = { ...selected, updatedAt: now() }
      changingSession = true
      try { showTurns(current.turns) } finally { changingSession = false }
      publish()
      flush()
      return true
    },
    /** Archive the current session and display an empty transcript. */
    startNew: (showTurns: (turns: SessionTurn[]) => void) => {
      flush()
      current = newSession(now())
      changingSession = true
      try { showTurns([]) } finally { changingSession = false }
      publish()
      flush()
    },
    /** Deletes a past session. The live session is not removable while its turns are on screen. */
    remove: (id: string) => {
      if (id === current.id) return
      sessions = loadSessions().filter((session) => session.id !== id)
      saveSessions(upsertSession(sessions, current))
      onSave?.(upsertSession(sessions, current))
      publish()
    },
    /** Deletes every past session, keeping the live one. */
    /** Remove saved history while retaining the session currently on screen. */
    clearPast: () => {
      sessions = []
      saveSessions(upsertSession(sessions, current))
      onSave?.(upsertSession(sessions, current))
      publish()
    },
    flush,
    /** Flush pending changes and release store/listener resources. */
    stop: () => {
      flush()
      unsubscribe()
      listeners.clear()
    },
  }
}

export type SessionHistory = ReturnType<typeof createSessionHistory>
