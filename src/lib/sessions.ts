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

const isTurn = (value: unknown): value is SessionTurn => {
  const turn = value as SessionTurn
  return Boolean(turn) && typeof turn.id === 'string' && (turn.role === 'user' || turn.role === 'jarvis')
    && typeof turn.text === 'string' && typeof turn.at === 'number'
}

const isSession = (value: unknown): value is ChatSession => {
  const session = value as ChatSession
  return Boolean(session) && typeof session.id === 'string' && typeof session.startedAt === 'number'
    && typeof session.updatedAt === 'number' && Array.isArray(session.turns)
}

export function loadSessions(): ChatSession[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSession)
      .map((session) => ({ ...session, turns: session.turns.filter(isTurn) }))
      .filter((session) => session.turns.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS)
  } catch {
    return []
  }
}

/** Writes newest-first; if storage is full, drops the oldest sessions until it fits. */
export function saveSessions(sessions: ChatSession[]): void {
  const keep = sessions.filter((session) => session.turns.length > 0)
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keep.slice(0, count)))
      return
    } catch {
      // Storage full or unavailable: retry without the oldest session.
    }
  }
}

/** Merges live turns into a session by id: known turns update in place, new ones append. */
export function recordTurns(session: ChatSession, turns: TurnLike[], now: number): ChatSession {
  const index = new Map(session.turns.map((turn, position) => [turn.id, position]))
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
        attachments: turn.attachments.map(({ name, mimeType, size, kind }) => ({ name, mimeType, size, kind })),
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
  const others = sessions.filter((entry) => entry.id !== session.id)
  if (!session.turns.length) return others
  return [session, ...others].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS)
}

export function sessionTitle(session: ChatSession): string {
  const first = session.turns.find((turn) => turn.role === 'user' && turn.text.trim())
    ?? session.turns.find((turn) => turn.text.trim())
  const text = first?.text.trim().replace(/\s+/g, ' ') ?? ''
  if (!text) return 'Untitled session'
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

export function startupSession(
  sessions: ChatSession[],
  { activeId, conversationId }: { activeId?: string | null; conversationId?: string } = {},
): ChatSession | null {
  if (activeId) return sessions.find((session) => session.id === activeId) ?? null
  const linked = conversationId && sessions.find((session) => session.conversationId === conversationId)
  return linked || [...sessions].sort((first, second) => second.updatedAt - first.updatedAt)[0] || null
}

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

  const publish = () => {
    snapshot = { sessions: upsertSession(sessions, current), currentId: current.id }
    listeners.forEach((listener) => listener())
  }
  const flush = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    // Re-read so other tabs' sessions and deletions are not overwritten.
    sessions = upsertSession(loadSessions(), current)
    saveSessions(sessions)
    onSave?.(sessions)
  }
  const schedule = () => {
    if (timer === null) timer = setTimeout(flush, delay)
  }

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
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    attachConversation: (conversationId: string) => {
      if (current.conversationId === conversationId) return
      current = { ...current, conversationId }
      publish()
      flush()
    },
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
    clearPast: () => {
      sessions = []
      saveSessions(upsertSession(sessions, current))
      onSave?.(upsertSession(sessions, current))
      publish()
    },
    flush,
    stop: () => {
      flush()
      unsubscribe()
      listeners.clear()
    },
  }
}

export type SessionHistory = ReturnType<typeof createSessionHistory>
