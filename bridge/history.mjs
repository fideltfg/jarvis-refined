import { createSdkMcpServer, query as sdkQuery, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
const flat = (s) => s.replace(/\s+/g, ' ').trim()
const title = (s) => clip(flat((s.turns.find((t) => t.role === 'user') ?? s.turns[0]).text), 70)
const who = (t) => (t.role === 'user' ? 'They' : 'You')

/** Without a summary: how it opened and how it ended. */
const gist = (s) => {
  const users = s.turns.filter((t) => t.role === 'user')
  const first = title(s)
  const last = users.length > 1 ? clip(flat(users[users.length - 1].text), 70) : ''
  return last ? `${first} … ${last}` : first
}

const cap = (text) =>
  text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS - 1)}…(cut short — narrow the search)`

/** One-line summaries of finished sessions, kept beside the history so a sync cannot erase them. */
const summaryFile = (file) => `${file}.summaries.json`

export function loadSummaries(file = HISTORY_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(summaryFile(file), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveSummaries(map, file) {
  const tmp = `${summaryFile(file)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 })
  renameSync(tmp, summaryFile(file))
}

export function recent(sessions, limit = 10, summaries = {}) {
  if (!sessions.length) return 'No past conversations are recorded.'
  return cap(
    sessions
      .slice(0, limit)
      .map((s) => `- ${s.id} · ${day(s.updatedAt)} · ${s.turns.length} turns · ${summaries[s.id]?.text ?? gist(s)}`)
      .join('\n'),
  )
}

const occurrences = (low, word) => low.split(word).length - 1

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'it', 'we', 'i', 'you', 'did', 'do', 'what', 'about', 'that', 'this', 'last', 'time', 'before', 'earlier', 'talk', 'talked', 'said', 'say', 'me', 'my', 'was', 'were', 'for', 'with'])

/**
 * Best matches first: a message holding more of the distinct words wins, then more occurrences,
 * then what they said over what was answered. One matching word is enough, since a spoken
 * question rarely repeats the exact words of the earlier answer.
 */
export function search(sessions, query, limit = 6) {
  const all = String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const words = all.filter((w) => !STOP.has(w))
  if (!words.length && !all.length) return 'No search words were given.'
  const terms = words.length ? words : all
  const hits = []
  for (const s of sessions) {
    for (const t of s.turns) {
      const low = t.text.toLowerCase()
      const distinct = terms.filter((w) => low.includes(w)).length
      if (!distinct) continue
      const score = distinct * 100 + terms.reduce((n, w) => n + occurrences(low, w), 0) + (t.role === 'user' ? 1 : 0)
      hits.push({ s, t, score })
    }
  }
  if (!hits.length) return `Nothing in past conversations matches "${query}".`
  hits.sort((a, b) => b.score - a.score || b.t.at - a.t.at)
  return cap(
    hits
      .slice(0, limit)
      .map(({ s, t }) => `[${s.id} · ${day(t.at)}] ${who(t)}: ${clip(flat(t.text), 200)}`)
      .join('\n'),
  )
}

const HEAD_TURNS = 3
const TAIL_TURNS = 5

/** Long conversations show their ends unless a turn range (1-based, inclusive) is asked for. */
export function read(sessions, id, from, to) {
  const s = sessions.find((x) => x.id === id)
  if (!s) return `No conversation with id ${id}.`
  const n = s.turns.length
  const line = (t, i) => `${i + 1}. ${who(t)}: ${t.text}`
  if (from != null || to != null) {
    const a = Math.max(1, from ?? 1)
    const b = Math.min(n, to ?? n)
    if (a > b) return `${id} has ${n} turns; no turns in that range.`
    return cap(s.turns.slice(a - 1, b).map((t, i) => line(t, a - 1 + i)).join('\n'))
  }
  if (n <= HEAD_TURNS + TAIL_TURNS) return cap(s.turns.map(line).join('\n'))
  const omitted = n - HEAD_TURNS - TAIL_TURNS
  return cap(
    [
      ...s.turns.slice(0, HEAD_TURNS).map(line),
      `…${omitted} turns omitted (turns ${HEAD_TURNS + 1}-${n - TAIL_TURNS}); pass from/to to read them.`,
      ...s.turns.slice(n - TAIL_TURNS).map((t, i) => line(t, n - TAIL_TURNS + i)),
    ].join('\n'),
  )
}

const IDLE_MS = 10 * 60 * 1000
const RESUMMARISE_AFTER = 6
const RETRY_MS = 60 * 60 * 1000
const SUMMARY_BATCH = 3

async function viaHaiku(transcript) {
  const prompt =
    'Summarise this conversation in one line of at most 20 words: the topics discussed and any decision reached. ' +
    `Reply with the line only.\n\n${transcript}`
  async function* once() {
    yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }
  }
  const options = { model: 'haiku', tools: [], settingSources: [], maxTurns: 1, persistSession: false, cwd: tmpdir() }
  for await (const msg of sdkQuery({ prompt: once(), options })) {
    if (msg.type !== 'result') continue
    if (msg.subtype === 'success' && msg.result) return flat(msg.result)
    throw new Error(msg.subtype)
  }
  throw new Error('no answer')
}

const failedAt = new Map()
let summarising = false

/** Summarises sessions that have gone quiet, a few at a time. Failures fall back to the opening question. */
export async function refreshSummaries(file = HISTORY_FILE, { summarize = viaHaiku, now = Date.now } = {}) {
  if (summarising) return 0
  summarising = true
  try {
    const sessions = load(file)
    const summaries = loadSummaries(file)
    const due = sessions
      .filter((s) => s.turns.length >= 2 && now() - s.updatedAt >= IDLE_MS)
      .filter((s) => !summaries[s.id] || s.turns.length - summaries[s.id].n >= RESUMMARISE_AFTER)
      .filter((s) => !failedAt.has(s.id) || now() - failedAt.get(s.id) >= RETRY_MS)
      .slice(0, SUMMARY_BATCH)
    let done = 0
    for (const s of due) {
      const text = s.turns.map((t) => `${who(t)}: ${clip(flat(t.text), 400)}`).join('\n')
      try {
        const line = await summarize(clip(text, 8000))
        summaries[s.id] = { n: s.turns.length, text: clip(line, 160) }
        done++
      } catch {
        failedAt.set(s.id, now())
      }
    }
    const live = new Set(sessions.map((s) => s.id))
    for (const id of Object.keys(summaries)) if (!live.has(id)) delete summaries[id]
    if (done || Object.keys(summaries).length !== Object.keys(loadSummaries(file)).length) saveSummaries(summaries, file)
    return done
  } finally {
    summarising = false
  }
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const SEEN = 'Already shown earlier in this conversation — see above.'

export function historyServer(file = HISTORY_FILE) {
  // Per connection: the model sometimes repeats an identical call.
  const seen = new Set()
  const once = (name, args, produce) => async (input) => {
    const sessions = load(file)
    const key = `${name}:${JSON.stringify(args(input))}:${sessions[0]?.updatedAt ?? 0}:${sessions.length}`
    if (seen.has(key)) return ok(SEEN)
    seen.add(key)
    return ok(produce(sessions, input))
  }

  return createSdkMcpServer({
    name: 'jarvis_history',
    version: '1.0.0',
    tools: [
      tool(
        'history_recent',
        'List their most recent past conversations with you (id, date, length, one-line summary). Summaries are only a guide: for any detail, history_read the session or history_search for it. Use for "last time" questions.',
        { limit: z.number().int().min(1).max(30).optional().catch(undefined) },
        once('recent', ({ limit }) => [limit], (sessions, { limit }) => recent(sessions, limit ?? 10, loadSummaries(file))),
      ),
      tool(
        'history_search',
        'Search past conversations for a remembered topic, name or phrase; best matches first, and one matching word is enough. Use it FIRST whenever they ask about anything said, decided or done earlier — never say there is no record before searching. Then history_read the best session.',
        { query: z.string().describe('Words to look for.') },
        once('search', ({ query }) => [query], (sessions, { query }) => search(sessions, query)),
      ),
      tool(
        'history_read',
        'Read one past conversation by the id shown in history_recent or history_search. A long one shows only its first and last turns; pass from/to (1-based turn numbers) to read the middle.',
        {
          id: z.string(),
          from: z.number().int().min(1).optional().catch(undefined),
          to: z.number().int().min(1).optional().catch(undefined),
        },
        once('read', ({ id, from, to }) => [id, from, to], (sessions, { id, from, to }) => read(sessions, id, from, to)),
      ),
    ],
  })
}
