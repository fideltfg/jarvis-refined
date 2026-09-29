import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseVariant, fileStem } from './sfx-variants.ts'

test('audio filenames use readable event names', () => {
  assert.equal(fileStem('panelOpen'), 'panel-open')
  assert.equal(fileStem('taskDone'), 'task-done')
  assert.equal(fileStem('wake'), 'wake')
})

test('variations are random without immediately repeating', () => {
  assert.equal(chooseVariant(1, 0, () => 0), 0)
  assert.equal(chooseVariant(3, -1, () => 0), 0)
  assert.equal(chooseVariant(3, -1, () => 0.99), 2)
  assert.equal(chooseVariant(3, 0, () => 0), 1)
  assert.equal(chooseVariant(3, 1, () => 0), 0)
  assert.equal(chooseVariant(3, 1, () => 0.99), 2)
  assert.equal(chooseVariant(3, 2, () => 0.99), 1)
})