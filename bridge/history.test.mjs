import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSummaries, read, recent, refreshSummaries, save, search } from './history.mjs'

const turns = (n) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'jarvis' : 'user', text: `turn ${i + 1}`, at: 1000 + i }))
const session = (id, n, updatedAt = 5000) => ({ id, startedAt: 1000, updatedAt, turns: turns(n) })

test('a long conversation shows its ends, and a range reads the middle', () => {
  const sessions = [session('a', 20)]
  const out = read(sessions, 'a')
  assert.match(out, /1\. They: turn 1/)
  assert.match(out, /12 turns omitted/)
  assert.match(out, /20\. You: turn 20/)
  assert.doesNotMatch(out, /turn 10\b/)
  assert.match(read(sessions, 'a', 9, 11), /10\. You: turn 10/)
})

test('search puts the most-matching, user-authored hit first', () => {
  const s = {
    id: 'a',
    startedAt: 1,
    updatedAt: 9,
    turns: [
      { role: 'jarvis', text: 'pricing once', at: 9 },
      { role: 'user', text: 'pricing pricing pricing', at: 1 },
    ],
  }
  assert.match(search([s], 'pricing').split('\n')[0], /They: pricing pricing/)
})

test('a spoken question still finds a message that shares only some of its words', () => {
  const s = {
    id: 'a',
    startedAt: 1,
    updatedAt: 9,
    turns: [{ role: 'user', text: 'Our pricing is annual only', at: 1 }],
  }
  assert.match(search([s], 'what did we say about pricing last time'), /annual only/)
  assert.match(search([s], 'zebra'), /Nothing/)
})

test('recent prefers a stored summary over the opening question', () => {
  const out = recent([session('a', 4)], 10, { a: { n: 4, text: 'Decided on annual pricing.' } })
  assert.match(out, /Decided on annual pricing\./)
})

test('only idle sessions are summarised, and not again until they grow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-history-'))
  const file = join(dir, 'sessions.json')
  try {
    save([session('old', 4, 1000), session('live', 4, 1_000_000)], file)
    const calls = []
    const summarize = async (text) => (calls.push(text), 'A summary.')
    const now = () => 1_000_000 + 1000

    assert.equal(await refreshSummaries(file, { summarize, now }), 1)
    assert.deepEqual(Object.keys(loadSummaries(file)), ['old'])
    assert.equal(await refreshSummaries(file, { summarize, now }), 0)

    save([session('old', 12, 1000), session('live', 4, 1_000_000)], file)
    assert.equal(await refreshSummaries(file, { summarize, now }), 1)
    assert.equal(loadSummaries(file).old.n, 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
