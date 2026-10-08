import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { close, load, parse } from './loose-ends.mjs'

const LEDGER = `# Loose Ends

## UnifiGuard

- [ ] 2026-10-06 · UnifiGuard · push commit 115c883 · CI red until pushed
- [~] 2026-10-05 · UnifiGuard · tag a release · notes drafted
- [x] 2026-10-04 · UnifiGuard · fix failing tests · suite green at 194

## Income

- [ ] 2026-10-06 · Income · research licensing routes
`

test('parses status, date, project, action and state', () => {
  const items = parse(LEDGER)
  assert.equal(items.length, 4)
  assert.deepEqual(items[0], {
    line: 4,
    date: '2026-10-06',
    project: 'UnifiGuard',
    action: 'push commit 115c883',
    state: 'CI red until pushed',
    status: 'open',
  })
  assert.equal(items[1].status, 'partial')
  assert.equal(items[2].status, 'done')
  assert.equal(items[3].project, 'Income')
  assert.equal(items[3].state, null)
})

test('falls back to the heading when a line names no project', () => {
  const items = parse('## Voyager\n\n- [ ] 2026-10-06 · run a diagnostic\n')
  assert.equal(items.length, 1)
  assert.equal(items[0].project, 'Voyager')
  assert.equal(items[0].action, 'run a diagnostic')
})

test('reads a bare line with no box and no date', () => {
  const items = parse('- push the branch\n')
  assert.deepEqual(items, [{ line: 0, date: null, project: null, action: 'push the branch', state: null, status: 'open' }])
})

test('drops lines it cannot read rather than throwing', () => {
  const items = parse('## P\n\nnot a bullet\n- [ ]\n- [ ] 2026-10-06 · real item\n')
  assert.equal(items.length, 1)
  assert.equal(items[0].action, 'real item')
})

test('counts only unfinished items as open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loose-'))
  const file = join(dir, 'loose-ends.md')
  writeFileSync(file, LEDGER)
  const ledger = load(file)
  assert.equal(ledger.missing, false)
  assert.equal(ledger.items.length, 4)
  assert.equal(ledger.open, 3)
})

test('a missing ledger means nothing outstanding, not an error', () => {
  const ledger = load(join(tmpdir(), 'loose-ends-absent-' + Date.now(), 'x.md'))
  assert.deepEqual(ledger, { items: [], open: 0, missing: true })
})

test('closes the selected open item in the markdown ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loose-close-'))
  const file = join(dir, 'loose-ends.md')
  writeFileSync(file, LEDGER)
  const item = load(file).items[0]

  const result = close(file, item)

  assert.equal(result.open, 2)
  assert.equal(result.items[0].status, 'done')
  assert.match(readFileSync(file, 'utf8'), /- \[x\] 2026-10-06 · UnifiGuard · push commit 115c883/)
  assert.match(readFileSync(file, 'utf8'), /- \[~\] 2026-10-05 · UnifiGuard · tag a release/)
})

test('refuses to close an entry if its ledger line has changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loose-stale-'))
  const file = join(dir, 'loose-ends.md')
  writeFileSync(file, LEDGER)
  const item = load(file).items[0]
  writeFileSync(file, LEDGER.replace('push commit 115c883', 'push commit 9abc'))

  assert.equal(close(file, item), null)
  assert.match(readFileSync(file, 'utf8'), /- \[ \] 2026-10-06 · UnifiGuard · push commit 9abc/)
})
