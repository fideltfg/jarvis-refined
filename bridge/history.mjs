import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Past conversations, readable by JARVIS. The browser owns the history in
 * localStorage; it mirrors it here over the socket so the agent can search it.
 */

export const HISTORY_FILE =
  process.env.JARVIS_HISTORY_FILE || join(homedir(), '.config', 'jarvis', 'sessions.json')

const MAX_SESSIONS = 200
const MAX_RESULT_CHARS = 6000

const isSession = (s) =>
  s && typeof s.id === 'string' && typeof s.startedAt === 'number' && typeof s.updatedAt === 'number' &&
  Array.isArray(s.turns)

/** Keeps only what recall needs: ids, times, role and text. */
export function normalise(sessions) {
  if (!Array.isArray(sessions)) return []
  return sessions
    .filter(isSession)
    .map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      turns: s.turns
        .filter((t) => t && (t.role === 'user' || t.role === 'jarvis') && typeof t.text === 'string')
        .map((t) => ({ role: t.role, text: t.text, at: typeof t.at === 'number' ? t.at : s.startedAt })),
    }))
    .filter((s) => s.turns.length)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS)
}

export function load(file = HISTORY_FILE) {
  try {
    return normalise(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

export function save(sessions, file = HISTORY_FILE) {
  const clean = normalise(sessions)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
  return clean.length
}

const day = (ms) => new Date(ms).toLocaleDateString('en-CA')
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const title = (s) => clip((s.turns.find((t) => t.role === 'user') ?? s.turns[0]).text.replace(/\s+/g, ' ').trim(), 70)

const cap = (text) =>
  text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS - 1)}…(cut short — narrow the search)`

export function recent(sessions, limit = 10) {
  if (!sessions.length) return 'No past conversations are recorded.'
  return cap(
    sessions
      .slice(0, limit)
      .map((s) => `- ${s.id} · ${day(s.updatedAt)} · ${s.turns.length} turns · ${title(s)}`)
      .join('\n'),
  )
}

export function search(sessions, query, limit = 12) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return 'No search words were given.'
  const hits = []
  for (const s of sessions) {
    for (const t of s.turns) {
      const low = t.text.toLowerCase()
      if (words.every((w) => low.includes(w))) hits.push({ s, t })
    }
  }
  if (!hits.length) return `Nothing in past conversations matches "${query}".`
  return cap(
    hits
      .slice(0, limit)
      .map(({ s, t }) => `[${s.id} · ${day(t.at)}] ${t.role === 'user' ? 'They' : 'You'}: ${clip(t.text.replace(/\s+/g, ' '), 300)}`)
      .join('\n'),
  )
}

export function read(sessions, id) {
  const s = sessions.find((x) => x.id === id)
  if (!s) return `No conversation with id ${id}.`
  return cap(s.turns.map((t) => `${t.role === 'user' ? 'They' : 'You'}: ${t.text}`).join('\n'))
}

const ok = (text) => ({ content: [{ type: 'text', text }] })

export function historyServer(file = HISTORY_FILE) {
  return createSdkMcpServer({
    name: 'jarvis_history',
    version: '1.0.0',
    tools: [
      tool(
        'history_recent',
        'List their most recent past conversations with you (id, date, length, opening question). Use to recall what you were last working on together.',
        { limit: z.number().int().min(1).max(30).optional().catch(undefined) },
        async ({ limit }) => ok(recent(load(file), limit ?? 10)),
      ),
      tool(
        'history_search',
        'Search past conversations for a remembered topic, name or phrase. Every word must appear in the same message. Use when they refer to something said before ("what did we decide about…").',
        { query: z.string().describe('Words to look for.') },
        async ({ query }) => ok(search(load(file), query)),
      ),
      tool(
        'history_read',
        'Read one past conversation in full, by the id shown in history_recent or history_search.',
        { id: z.string() },
        async ({ id }) => ok(read(load(file), id)),
      ),
    ],
  })
}
