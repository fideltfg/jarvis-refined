import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The loose-ends ledger — work JARVIS himself left un-done, un-started or
 * incomplete.
 *
 * This is deliberately not the PA to-do list. `pa.md` holds what the *user*
 * committed to; this file holds what the assistant started and did not finish:
 * a fix applied but unverified, a commit unpushed, a search abandoned when the
 * conversation turned. Those are the things that otherwise evaporate when a
 * session ends, and the ones the next session should pick up first.
 *
 * Same discipline as the memory file: one Markdown file the user can open and
 * edit by hand, fixed shape, one item per line. A line the parser cannot read
 * is dropped from the list rather than breaking it.
 *
 * Line format, under a `## Project` heading:
 *
 *   - [ ] 2026-10-06 · UnifiGuard · push commit 115c883 · CI red until pushed
 *
 * The box is the status, and the fields after it are date, project, action and
 * state. Only the action is required; everything else degrades to null.
 */

export const LOOSE_ENDS_FILE =
  process.env.JARVIS_LOOSE_ENDS_FILE || join(homedir(), '.config', 'jarvis', 'loose-ends.md')

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** The separator is a middle dot with spaces; hand edits often use a hyphen. */
const SPLIT = /\s+(?:·|—|\|)\s+/

const STATUS = { ' ': 'open', '': 'open', '~': 'partial', x: 'done', X: 'done' }

/** Split a ledger line into fields, tolerating any of them being absent. */
function fields(rest) {
  const parts = rest.split(SPLIT).map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return null
  const date = DATE.test(parts[0]) ? parts.shift() : null
  // With a date present the next field is the project; without one, the line is
  // bare and whatever is left is all action.
  const project = date && parts.length > 1 ? parts.shift() : null
  const action = parts.shift() ?? null
  if (!action) return null
  return { date, project, action, state: parts.length ? parts.join(' · ') : null }
}

export function parse(text) {
  const items = []
  let heading = null
  for (const [lineNumber, raw] of String(text ?? '').split('\n').entries()) {
    const line = raw.trim()
    const head = line.match(/^##\s+(.*)$/)
    if (head) { heading = head[1].trim() || null; continue }
    const bullet = line.match(/^[-*]\s+(?:\[( |~|x|X)?\]\s*)?(.*)$/)
    if (!bullet) continue
    const status = STATUS[bullet[1] ?? ''] ?? 'open'
    const parsed = fields(bullet[2])
    if (!parsed) continue
    items.push({ line: lineNumber, ...parsed, project: parsed.project || heading, status })
  }
  return items
}

/**
 * The ledger as it stands. A missing file is not an error — it means nothing
 * has been left undone yet, which is the state a fresh install is in.
 */
export function load(file = LOOSE_ENDS_FILE) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { items: [], open: 0, missing: true }
    throw err
  }
  const items = parse(text)
  return { items, open: items.filter((item) => item.status !== 'done').length, missing: false }
}

/** Mark one unchanged ledger entry closed, refusing stale list snapshots. */
export function close(file = LOOSE_ENDS_FILE, expected) {
  if (!expected || !Number.isInteger(expected.line) || expected.line < 0) return null
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }

  const target = parse(text).find((item) => item.line === expected.line)
  if (!target || ['date', 'project', 'action', 'state', 'status'].some((key) => target[key] !== expected[key])) return null
  if (target.status === 'done') return load(file)

  const lines = text.split('\n')
  const bullet = lines[target.line].match(/^(\s*[-*]\s+)(?:\[(?: |~|x|X)?\]\s*)?(.*)$/)
  if (!bullet) return null
  lines[target.line] = `${bullet[1]}[x] ${bullet[2]}`
  writeFileSync(file, lines.join('\n'), 'utf8')
  return load(file)
}
