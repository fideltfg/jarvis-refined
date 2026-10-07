import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTurnProgress, waitForInterruptedTurn } from './turns.mjs'

test('interrupt acknowledgement alone does not admit the next turn', async () => {
  const stopped = Promise.withResolvers()
  let admitted = false
  const waiting = waitForInterruptedTurn({ interrupt: async () => {} }, stopped.promise)
    .then(() => { admitted = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(admitted, false)
  stopped.resolve()
  await waiting
  assert.equal(admitted, true)
})

test('an interrupt without a result fails instead of reusing the old reader', async () => {
  await assert.rejects(waitForInterruptedTurn({ interrupt: async () => {} }, new Promise(() => {}), 5),
    /did not finish interrupting/)
})

test('a stuck interrupt acknowledgement is also bounded', async () => {
  await assert.rejects(waitForInterruptedTurn({ interrupt: () => new Promise(() => {}) }, Promise.resolve(), 5),
    /did not finish interrupting/)
})

test('an interrupt error is not mistaken for a completed turn', async () => {
  await assert.rejects(waitForInterruptedTurn({ interrupt: async () => { throw new Error('session ended') } },
    Promise.resolve()), /session ended/)
})

test('only real turn progress refreshes activity, not session keepalives', () => {
  assert.equal(isTurnProgress({ type: 'tool_progress' }), true)
  assert.equal(isTurnProgress({ type: 'system', subtype: 'api_retry' }), true)
  assert.equal(isTurnProgress({ type: 'system', subtype: 'status' }), true)
  assert.equal(isTurnProgress({ type: 'stream_event', event: {
    type: 'content_block_delta', delta: { type: 'thinking_delta' },
  } }), true)
  assert.equal(isTurnProgress({ type: 'stream_event', event: {
    type: 'content_block_delta', delta: { type: 'input_json_delta' },
  } }), true)
  assert.equal(isTurnProgress({ type: 'system', subtype: 'init' }), false)
  assert.equal(isTurnProgress({ type: 'keep_alive' }), false)
})