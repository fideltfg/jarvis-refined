import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The `pa_*` tools — JARVIS's memory as a personal assistant.
 *
 * Every other session this bridge opens starts from nothing, by design:
 * settingSources is empty, so no CLAUDE.md and no history ride along. That is
 * right for a voice turn and wrong for an assistant, who is only useful if he
 * remembers what you are working towards, what you said you would do, and what
 * you did last week.
 *
 * So the memory is one Markdown file — goals, focus, tasks, notes, log — that
 * the user can open and edit by hand, that is summarised into the system prompt
 * on connect, and that these tools change as the conversation goes. It is kept
 * deliberately dumb: fixed sections, one item per line, nothing that a hand
 * edit could leave half-parsed. A line the parser does not understand is
 * dropped from view, not fatal.
 */

export const MEMORY_FILE =
  process.env.JARVIS_MEMORY_FILE || join(homedir(), '.config', 'jarvis', 'pa.md')

const TITLE = '# JARVIS — PA memory'
const SECTIONS = ['Goals', 'Focus', 'Tasks', 'Notes', 'Log']
const DATE = /\d{4}-\d{2}-\d{2}/
const LOG_IN_PROMPT = 10

export const today = () => new Date().toLocaleDateString('en-CA')

const empty = () => ({ goals: [], focus: '', tasks: [], notes: [], log: [] })

const bullet = (line) => {
  const m = line.match(/^[-*]\s+(.*)$/)
  return m ? m[1].trim() : null
}

export function parse(text) {
  const state = empty()
  let section = null
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    const heading = line.match(/^##\s+(.*)$/)
    if (heading) {
      const name = heading[1].trim().toLowerCase()
      section = SECTIONS.find((s) => s.toLowerCase() === name) ?? null
      continue
    }
    if (!line || !section) continue

    if (section === 'Focus') {
      state.focus = state.focus ? `${state.focus} ${line}` : line
      continue
    }
    const item = bullet(line)
    if (!item) continue

    if (section === 'Goals') state.goals.push(item)
    else if (section === 'Notes') state.notes.push(item)
    else if (section === 'Tasks') {
      const m = item.match(/^(?:\[( |x|X)\]\s*)?(.*?)(?:\s+\(added (\d{4}-\d{2}-\d{2})\))?$/)
      if (m[1] && m[1] !== ' ') continue // ticked by hand: finished, not open
      if (m[2]) state.tasks.push({ text: m[2], added: m[3] ?? null })
    } else if (section === 'Log') {
      const m = item.match(new RegExp(`^(${DATE.source})\\s+(.*)$`))
      state.log.push(m ? { date: m[1], text: m[2] } : { date: null, text: item })
    }
  }
  return state
}

export function serialize(state) {
  const list = (items) => items.map((i) => `- ${i}\n`).join('')
  const tasks = state.tasks
    .map((t) => `- [ ] ${t.text}${t.added ? ` (added ${t.added})` : ''}\n`)
    .join('')
  const log = state.log.map((l) => `- ${l.date ? `${l.date} ` : ''}${l.text}\n`).join('')
  const body = {
    Goals: list(state.goals),
    Focus: state.focus ? `${state.focus}\n` : '',
    Tasks: tasks,
    Notes: list(state.notes),
    Log: log,
  }
  return `${TITLE}\n` + SECTIONS.map((s) => `\n## ${s}\n${body[s]}`).join('')
}

/**
 * Finding an item from a spoken phrase. Nobody says "task three" out loud;
 * they say "the pricing one". Exact text wins outright; otherwise the item
 * sharing the most words with the phrase, and a tie is reported rather than
 * guessed, because completing the wrong task is worse than asking.
 */
const FILLER = new Set(['the', 'a', 'an', 'one', 'that', 'this', 'task', 'goal', 'note', 'to', 'about', 'my', 'thing'])
const words = (s) =>
  String(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !FILLER.has(w))

const near = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)))

function find(items, phrase, label = (x) => x) {
  const want = String(phrase).trim().toLowerCase()
  const exact = items.findIndex((i) => label(i).toLowerCase() === want)
  if (exact >= 0) return { index: exact }

  const q = words(phrase)
  const scores = items.map((i) => {
    const w = words(label(i))
    return q.filter((x) => w.some((y) => near(x, y))).length
  })
  const best = Math.max(0, ...scores)
  if (best === 0) return { index: -1, matches: [] }
  const matches = items.filter((_, n) => scores[n] === best)
  return matches.length === 1 ? { index: scores.indexOf(best) } : { index: -1, matches: matches.map(label) }
}

const clean = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '')
const same = (state, reply) => ({ state, reply })
const NOTHING = 'Nothing to record — no text was given.'

function missed(kind, phrase, result) {
  return result.matches.length
    ? `Which ${kind}? "${phrase}" matches: ${result.matches.join('; ')}.`
    : `No ${kind} matches "${phrase}".`
}

/** A list section with add and remove — goals and notes behave identically. */
function listOp(key, kind) {
  return (state, { action, text }) => {
    const t = clean(text)
    if (!t) return same(state, NOTHING)
    if (action === 'remove') {
      const r = find(state[key], t)
      if (r.index < 0) return same(state, missed(kind, t, r))
      const removed = state[key][r.index]
      return { state: { ...state, [key]: state[key].filter((_, n) => n !== r.index) }, reply: `Removed ${kind}: ${removed}.` }
    }
    return { state: { ...state, [key]: [...state[key], t] }, reply: `Added ${kind}: ${t}.` }
  }
}

/**
 * Pure: each takes the state and the tool arguments and returns the next state
 * plus what to tell the model. An unchanged state is returned as the very same
 * object, which is how update() knows not to touch the file.
 */
export const ops = {
  goal: listOp('goals', 'goal'),
  note: listOp('notes', 'note'),

  focus(state, { text }) {
    const t = clean(text)
    if (!t) return same(state, NOTHING)
    return { state: { ...state, focus: t }, reply: `Focus set: ${t}.` }
  },

  log(state, { text }, date) {
    const t = clean(text)
    if (!t) return same(state, NOTHING)
    return { state: { ...state, log: [...state.log, { date, text: t }] }, reply: `Logged: ${t}.` }
  },

  task(state, { action, text }, date) {
    const t = clean(text)
    if (!t) return same(state, NOTHING)
    if (action === 'done' || action === 'drop') {
      const r = find(state.tasks, t, (x) => x.text)
      if (r.index < 0) return same(state, missed('task', t, r))
      const task = state.tasks[r.index]
      const tasks = state.tasks.filter((_, n) => n !== r.index)
      if (action === 'drop') return { state: { ...state, tasks }, reply: `Dropped: ${task.text}.` }
      return {
        state: { ...state, tasks, log: [...state.log, { date, text: `Done: ${task.text}` }] },
        reply: `Done and logged: ${task.text}. ${tasks.length} open.`,
      }
    }
    return {
      state: { ...state, tasks: [...state.tasks, { text: t, added: date }] },
      reply: `Added task: ${t}. ${state.tasks.length + 1} open.`,
    }
  },
}

/** What rides in the system prompt: open work and recent history, capped. */
export function summary(state, { maxChars = 6000 } = {}) {
  const parts = []
  if (state.goals.length) parts.push(`Goals:\n${state.goals.map((g) => `- ${g}`).join('\n')}`)
  if (state.focus) parts.push(`Current focus: ${state.focus}`)
  if (state.tasks.length)
    parts.push(`Open tasks:\n${state.tasks.map((t) => `- ${t.text}${t.added ? ` (since ${t.added})` : ''}`).join('\n')}`)
  if (state.notes.length) parts.push(`Notes about them:\n${state.notes.map((n) => `- ${n}`).join('\n')}`)
  if (state.log.length)
    parts.push(
      `Recent progress:\n${state.log
        .slice(-LOG_IN_PROMPT)
        .map((l) => `- ${l.date ? `${l.date} ` : ''}${l.text}`)
        .join('\n')}`,
    )
  const out = parts.length ? parts.join('\n\n') : 'The memory is empty — nothing recorded yet.'
  if (out.length <= maxChars) return out
  const tail = '\n…(cut short — pa_read has the rest)'
  return out.slice(0, Math.max(0, maxChars - tail.length)) + tail
}

export function load(file = MEMORY_FILE) {
  try {
    return parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return empty()
    throw err
  }
}

/** Written aside and renamed in, so a crash mid-write never leaves half a file. */
function save(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, serialize(state), { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}

/**
 * Read-modify-write, one at a time per file. The model happily fires two tools
 * in one turn ("add that and log this"), and two sockets can be open at once;
 * without the queue the second write would be computed from a stale read.
 */
const queues = new Map()
export function update(file, change) {
  const run = (queues.get(file) ?? Promise.resolve()).then(() => {
    const before = load(file)
    const { state, reply } = change(before)
    if (state !== before) save(file, state)
    return reply
  })
  queues.set(file, run.catch(() => {}))
  return run
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

const text = (note) => z.union([z.string(), z.number()]).optional().catch(undefined).transform((v) => (v == null ? undefined : String(v))).describe(note)
const action = (values, fallback, note) => z.enum(values).default(fallback).catch(fallback).describe(note)

export function memoryServer(file = MEMORY_FILE) {
  const run = (op) => async (args) => {
    try {
      return ok(await update(file, (s) => ops[op](s, args, today())))
    } catch (err) {
      return refuse(`The memory file could not be updated: ${err.message}`)
    }
  }

  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    tools: [
      tool(
        'pa_read',
        'Read the whole PA memory — every goal, task, note and the full progress log. The conversation already opens with a summary from when it began; use this when you need older log entries or anything changed since.',
        {},
        async () => {
          try {
            return ok(serialize(load(file)))
          } catch (err) {
            return refuse(`The memory file could not be read: ${err.message}`)
          }
        },
      ),
      tool(
        'pa_task',
        'Their to-do list. "add" when they commit to doing something ("I need to…", "remind me to…"). "done" when they report finishing one — it is removed and logged. "drop" when they abandon one. For done/drop, `text` can be any phrase that identifies it ("the pricing one"); if it is ambiguous you will be told the candidates, so ask which.',
        {
          action: action(['add', 'done', 'drop'], 'add', 'add, done, or drop.'),
          text: text('The task, or for done/drop a phrase identifying it.'),
        },
        run('task'),
      ),
      tool(
        'pa_goal',
        'Their longer-term goals — what the tasks are in service of. Add only when they state a goal, not for every wish in passing.',
        {
          action: action(['add', 'remove'], 'add', 'add or remove.'),
          text: text('The goal, or a phrase identifying the one to remove.'),
        },
        run('goal'),
      ),
      tool(
        'pa_focus',
        'Set the one thing they are concentrating on right now. Replaces the previous focus.',
        { text: text('The new focus, in a short phrase.') },
        run('focus'),
      ),
      tool(
        'pa_log',
        'Record progress with today\'s date — something shipped, decided, learned or earned. Use it whenever they report an outcome, even in passing. Finishing a listed task logs itself; do not log it twice.',
        { text: text('What happened, in one short line.') },
        run('log'),
      ),
      tool(
        'pa_note',
        'Durable facts about them or their business worth knowing next time: preferences, constraints, prices, names. Add when they tell you one or ask you to remember something; remove when they correct it.',
        {
          action: action(['add', 'remove'], 'add', 'add or remove.'),
          text: text('The fact, or a phrase identifying the one to remove.'),
        },
        run('note'),
      ),
    ],
  })
}

/**
 * How to use the memory. Fixed text, so it can sit in the cached system prompt;
 * the snapshot itself changes with every pa_* write and travels separately.
 */
export const MEMORY_GUIDE = `Personal assistant memory:
- You are also their personal assistant, helping them build an income. The
  memory snapshot at the start of the conversation is what you knew when it
  began; the \`pa_*\` tools keep it current, and it is how the next
  conversation will know anything at all.
- Record as it happens and without comment: a task when they commit to one,
  done when they report it, a log line for any outcome, a note for any durable
  fact. Never announce that you have saved something — at most "Noted."
- Bring up the focus or an open task only when it bears on what they asked, or
  when they ask what to do next. Never recite the list unprompted.
- Past conversations are searchable with \`history_search\`, \`history_recent\`
  and \`history_read\`. When they ask about anything said, decided or done in an
  earlier conversation, search it before answering and read the best session if
  the snippets are not enough; never say there is no record without searching.
  Do not recite old conversations unprompted.
- When they ask what to do, choose one thing from the open tasks, in service of
  a goal, and say why in a sentence.`

/** The memory as it stands now. Read fresh for every connection. */
export function memorySnapshot(file = MEMORY_FILE) {
  try {
    return summary(load(file))
  } catch (err) {
    return `The memory file could not be read (${err.message}). Say so once if they ask about their plans.`
  }
}
