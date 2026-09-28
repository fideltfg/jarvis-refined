import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse, serialize, ops, summary, load, update } from './memory.mjs'

const TODAY = '2026-09-27'

const SAMPLE = `# JARVIS — PA memory

## Goals
- Launch UnifiGuard paid tier

## Focus
Pricing page this week

## Tasks
- [ ] Draft pricing page (added 2026-09-20)
- [ ] Email three beta users (added 2026-09-21)

## Notes
- Prefers one-time licences over subscriptions

## Log
- 2026-09-25 Shipped licence key check
`

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'pa-')), 'pa.md')

test('parse reads every section', () => {
  const s = parse(SAMPLE)
  assert.deepEqual(s.goals, ['Launch UnifiGuard paid tier'])
  assert.equal(s.focus, 'Pricing page this week')
  assert.deepEqual(s.tasks, [
    { text: 'Draft pricing page', added: '2026-09-20' },
    { text: 'Email three beta users', added: '2026-09-21' },
  ])
  assert.deepEqual(s.notes, ['Prefers one-time licences over subscriptions'])
  assert.deepEqual(s.log, [{ date: '2026-09-25', text: 'Shipped licence key check' }])
})

test('serialize round-trips', () => {
  assert.equal(serialize(parse(SAMPLE)), SAMPLE)
})

test('parse tolerates junk, unknown sections and hand-edited lines', () => {
  const s = parse('random preamble\n## Tasks\n- plain line task\n* [x] finished\n## Weird\n- ignored\n')
  assert.deepEqual(s.tasks, [{ text: 'plain line task', added: null }])
  assert.deepEqual(s.goals, [])
  assert.equal(s.focus, '')
})

test('task add, done and drop', () => {
  let { state, reply } = ops.task(parse(SAMPLE), { action: 'add', text: 'Record demo video' }, TODAY)
  assert.equal(state.tasks.at(-1).text, 'Record demo video')
  assert.equal(state.tasks.at(-1).added, TODAY)
  assert.match(reply, /Added/)

  ;({ state, reply } = ops.task(state, { action: 'done', text: 'the pricing one' }, TODAY))
  assert.ok(!state.tasks.some((t) => t.text === 'Draft pricing page'))
  assert.deepEqual(state.log.at(-1), { date: TODAY, text: 'Done: Draft pricing page' })

  ;({ state } = ops.task(state, { action: 'drop', text: 'beta users' }, TODAY))
  assert.deepEqual(state.tasks.map((t) => t.text), ['Record demo video'])
})

test('an unmatched or ambiguous phrase changes nothing and says why', () => {
  const before = parse(SAMPLE)
  const miss = ops.task(before, { action: 'done', text: 'invoices' }, TODAY)
  assert.equal(miss.state, before)
  assert.match(miss.reply, /No task matches/)

  const two = parse('## Tasks\n- [ ] Email Bob\n- [ ] Email Alice\n')
  const amb = ops.task(two, { action: 'done', text: 'email' }, TODAY)
  assert.equal(amb.state, two)
  assert.match(amb.reply, /Email Bob/)
  assert.match(amb.reply, /Email Alice/)
})

test('goal, focus, note and log', () => {
  let s = parse(SAMPLE)
  s = ops.goal(s, { action: 'add', text: 'Grow YouTube to 1k subs' }, TODAY).state
  assert.equal(s.goals.length, 2)
  s = ops.goal(s, { action: 'remove', text: 'unifiguard' }, TODAY).state
  assert.deepEqual(s.goals, ['Grow YouTube to 1k subs'])

  s = ops.focus(s, { text: 'Film the Jarvis demo' }, TODAY).state
  assert.equal(s.focus, 'Film the Jarvis demo')

  s = ops.note(s, { action: 'add', text: 'Works best mornings' }, TODAY).state
  s = ops.note(s, { action: 'remove', text: 'licences' }, TODAY).state
  assert.deepEqual(s.notes, ['Works best mornings'])

  s = ops.log(s, { text: 'Outlined video script' }, TODAY).state
  assert.deepEqual(s.log.at(-1), { date: TODAY, text: 'Outlined video script' })
})

test('empty text is refused without a change', () => {
  const s = parse(SAMPLE)
  for (const r of [
    ops.task(s, { action: 'add', text: '  ' }, TODAY),
    ops.log(s, {}, TODAY),
    ops.note(s, { action: 'add' }, TODAY),
  ]) {
    assert.equal(r.state, s)
    assert.match(r.reply, /Nothing/)
  }
})

test('summary shows recent log only and stays under the cap', () => {
  const s = parse(SAMPLE)
  for (let i = 0; i < 30; i++) s.log.push({ date: TODAY, text: `entry ${i}` })
  const out = summary(s, { maxChars: 6000 })
  assert.match(out, /Pricing page this week/)
  assert.match(out, /entry 29/)
  assert.doesNotMatch(out, /entry 19\b/)
  assert.ok(summary(s, { maxChars: 200 }).length <= 200)
})

test('summary of an empty memory says so', () => {
  assert.match(summary(parse('')), /empty/i)
})

test('load of a missing file is empty; update creates it private', async () => {
  const file = tmpFile()
  assert.deepEqual(load(file).tasks, [])
  const reply = await update(file, (s) => ops.log(s, { text: 'first' }, TODAY))
  assert.match(reply, /Logged/)
  assert.match(readFileSync(file, 'utf8'), /2026-09-27 first/)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('updates are serialised, so concurrent writes are not lost', async () => {
  const file = tmpFile()
  writeFileSync(file, SAMPLE)
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => update(file, (s) => ops.log(s, { text: `n${i}` }, TODAY))),
  )
  assert.equal(load(file).log.length, 11)
})
