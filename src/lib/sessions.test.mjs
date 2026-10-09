import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_SESSIONS,
  STORAGE_KEY,
  createSessionHistory,
  loadSessions,
  recordTurns,
  saveSessions,
  sessionTitle,
  startupSession,
  upsertSession,
} from './sessions.ts'

/** Install a localStorage fixture that can simulate quota failures. */
function storage({ quota = Infinity } = {}) {
  const map = new Map()
  globalThis.localStorage = {
    // Match browser storage's null result for keys that have not been written.
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    // Raise a quota error when the serialized value exceeds the fixture limit.
    setItem: (key, value) => {
      if (String(value).length > quota) throw new Error('QuotaExceededError')
      map.set(key, String(value))
    },
    // Delete the key and report whether it existed, as Map does.
    removeItem: (key) => map.delete(key),
  }
  return map
}

/** Create a tiny subscribable turn store for history recorder tests. */
function fakeStore(turns = []) {
  let state = { turns }
  const listeners = new Set()
  return {
    /** Return the current state object used by the history recorder. */
    getState: () => state,
    /** Subscribe to updates and return a way to unregister the listener. */
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Publish a new turns array with the previous state for change detection. */
    setTurns: (next) => {
      const previous = state
      state = { turns: next }
      // Notify every recorder observing this fake store.
      listeners.forEach((listener) => listener(state, previous))
    },
  }
}

/** Build a valid saved session fixture with one user turn by default. */
const session = (id, updatedAt, turns = [{ id: `${id}-t`, role: 'user', text: id, at: updatedAt }]) =>
  ({ id, startedAt: updatedAt, updatedAt, turns })

// Verifies turn ids preserve insertion position and first-seen timestamps as text streams.
test('recordTurns appends new turns, updates streamed text in place and keeps first-seen time', () => {
  const empty = session('s', 1, [])
  const first = recordTurns(empty, [{ id: 'a', role: 'user', text: 'hi' }], 10)
  const streamed = recordTurns(first, [{ id: 'a', role: 'user', text: 'hi' }, { id: 'b', role: 'jarvis', text: 'Hel' }], 20)
  const done = recordTurns(streamed, [{ id: 'b', role: 'jarvis', text: 'Hello', tools: ['search'] }], 30)
  assert.deepEqual(done.turns.map(({ id, text, at }) => [id, text, at]), [['a', 'hi', 10], ['b', 'Hello', 20]])
  assert.deepEqual(done.turns[1].tools, ['search'])
  assert.equal(done.updatedAt, 30)
  assert.equal(recordTurns(done, [{ id: 'b', role: 'jarvis', text: 'Hello', tools: ['search'] }], 40), done)
})

// Ensures the recorder merges snapshots instead of deleting turns trimmed from live state.
test('turns trimmed from the live store stay in the recorded session', () => {
  const recorded = recordTurns(session('s', 1, []), [{ id: 'a', role: 'user', text: '1' }, { id: 'b', role: 'jarvis', text: '2' }], 5)
  const next = recordTurns(recorded, [{ id: 'b', role: 'jarvis', text: '2' }, { id: 'c', role: 'user', text: '3' }], 6)
  assert.deepEqual(next.turns.map((turn) => turn.id), ['a', 'b', 'c'])
})

// Checks upsert ordering, maximum history size, and omission of empty sessions.
test('upsertSession sorts newest first, caps the list and drops empty sessions', () => {
  let list = []
  for (let i = 0; i < MAX_SESSIONS + 5; i++) list = upsertSession(list, session(`s${i}`, i))
  assert.equal(list.length, MAX_SESSIONS)
  assert.equal(list[0].id, `s${MAX_SESSIONS + 4}`)
  assert.equal(upsertSession(list, session('s0', 999, [])).some((entry) => entry.id === 's0'), false)
})

// Covers user-first titles, transcript fallback, truncation, and the empty label.
test('sessionTitle uses the first thing the user said', () => {
  assert.equal(sessionTitle(session('s', 1, [{ id: 'a', role: 'jarvis', text: 'Ready.', at: 1 }, { id: 'b', role: 'user', text: '  what\nis the weather ', at: 2 }])), 'what is the weather')
  assert.equal(sessionTitle(session('s', 1, [{ id: 'a', role: 'user', text: 'x'.repeat(80), at: 1 }])).length, 60)
  assert.equal(sessionTitle(session('s', 1, [{ id: 'a', role: 'user', text: '', at: 1 }])), 'Untitled session')
})

// Confirms unreadable JSON and malformed session records safely produce valid history only.
test('loading ignores corrupt or malformed storage', () => {
  const map = storage()
  map.set(STORAGE_KEY, '{ nope')
  assert.deepEqual(loadSessions(), [])
  map.set(STORAGE_KEY, JSON.stringify([null, { id: 1 }, session('ok', 5), session('bad-turns', 6, [{ id: 'x' }])]))
  assert.deepEqual(loadSessions().map((entry) => entry.id), ['ok'])
})

// Verifies storage-quota retries keep the newest sessions first.
test('saving drops the oldest sessions when storage is full', () => {
  const map = storage({ quota: 260 })
  saveSessions([session('new', 3), session('mid', 2), session('old', 1)])
  const saved = JSON.parse(map.get(STORAGE_KEY))
  assert.ok(saved.length >= 1 && saved.length < 3)
  assert.equal(saved[0].id, 'new')
})

// Exercises debounced persistence, new-session creation, and history deletion controls.
test('the recorder persists the live session, debounced, and splits on a cleared transcript', () => {
  const map = storage()
  map.set(STORAGE_KEY, JSON.stringify([session('past', 1)]))
  const timers = []
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  // Capture delayed saves so the test can trigger them deterministically.
  globalThis.setTimeout = (callback) => { timers.push(callback); return timers.length }
  globalThis.clearTimeout = () => {}
  try {
    let clock = 100
    const store = fakeStore()
    const history = createSessionHistory(store, { now: () => clock })
    let notified = 0
    // Count snapshot notifications emitted after recorder state changes.
    history.subscribe(() => notified++)

    store.setTurns([{ id: 'a', role: 'user', text: 'hello' }])
    clock = 110
    store.setTurns([{ id: 'a', role: 'user', text: 'hello' }, { id: 'b', role: 'jarvis', text: 'Hi' }])
    assert.equal(timers.length, 1, 'streamed updates share one pending save')
    assert.equal(notified, 2)
    const first = history.getSnapshot()
    assert.deepEqual(first.sessions.map((entry) => entry.id), [first.currentId, 'past'])

    timers[0]()
    assert.equal(JSON.parse(map.get(STORAGE_KEY)).length, 2)

    clock = 120
    store.setTurns([])
    const second = history.getSnapshot()
    assert.notEqual(second.currentId, first.currentId)
    assert.equal(second.sessions.length, 2, 'the new session is hidden until it has turns')

    history.remove('past')
    assert.deepEqual(history.getSnapshot().sessions.map((entry) => entry.id), [first.currentId])
    history.clearPast()
    assert.deepEqual(history.getSnapshot().sessions, [])
    history.stop()
  } finally {
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
  }
})

// Ensures each save reloads shared storage so one tab does not erase the other's history.
test('two tabs saving keep each other\'s sessions', () => {
  const map = storage()
  const first = fakeStore()
  const second = fakeStore()
  const a = createSessionHistory(first, { now: () => 1 })
  const b = createSessionHistory(second, { now: () => 2 })
  first.setTurns([{ id: 'a', role: 'user', text: 'from tab one' }])
  second.setTurns([{ id: 'b', role: 'user', text: 'from tab two' }])
  a.flush()
  b.flush()
  assert.equal(JSON.parse(map.get(STORAGE_KEY)).length, 2)
  a.stop()
  b.stop()
})

// Protects the current transcript from history deletion and clear-past operations.
test('the live session cannot be deleted while it is on screen', () => {
  storage()
  const store = fakeStore([{ id: 'a', role: 'user', text: 'keep me' }])
  const history = createSessionHistory(store, { now: () => 1 })
  history.remove(history.getSnapshot().currentId)
  history.clearPast()
  assert.equal(history.getSnapshot().sessions.length, 1)
  history.stop()
})

// Checks that a new-session handoff lets the old active session be removed permanently.
test('deleting an active session after a fresh-session handoff clears its turns and stays deleted', () => {
  storage()
  saveSessions([session('keep', 2)])
  const store = fakeStore([{ id: 'active-turn', role: 'user', text: 'delete this context' }])
  const history = createSessionHistory(store, { now: () => 10 })
  try {
    history.attachConversation('old-conversation')
    const deletedId = history.getSnapshot().currentId
    history.startNew(store.setTurns)
    history.attachConversation('new-conversation')
    history.remove(deletedId)
    assert.deepEqual(store.getState().turns, [])
    assert.notEqual(history.getSnapshot().currentId, deletedId)
    assert.deepEqual(loadSessions().map((entry) => entry.id), ['keep'])
    store.setTurns([{ id: 'fresh-turn', role: 'user', text: 'new context' }])
    history.flush()
    assert.equal(loadSessions().some((entry) => entry.id === deletedId), false)
    const current = loadSessions().find((entry) => entry.id === history.getSnapshot().currentId)
    assert.equal(current.conversationId, 'new-conversation')
    assert.deepEqual(current.turns.map((turn) => turn.text), ['new context'])
  } finally {
    history.stop()
  }
})

// Confirms deletion persists across later saves while preserving unrelated sessions.
test('removing one past session preserves the others and stays deleted after a live save', () => {
  storage()
  saveSessions([session('keep', 2), session('delete', 1)])
  const store = fakeStore([{ id: 'live-turn', role: 'user', text: 'current conversation' }])
  const saved = []
  // Capture persisted snapshots to verify the deletion remains reflected.
  const history = createSessionHistory(store, { now: () => 10, onSave: (sessions) => saved.push(sessions) })
  try {
    const currentId = history.getSnapshot().currentId
    history.remove('delete')
    assert.deepEqual(history.getSnapshot().sessions.map((entry) => entry.id), [currentId, 'keep'])
    assert.deepEqual(loadSessions().map((entry) => entry.id), [currentId, 'keep'])
    assert.deepEqual(saved.at(-1).map((entry) => entry.id), [currentId, 'keep'])
    store.setTurns([{ id: 'live-turn', role: 'user', text: 'updated conversation' }])
    history.flush()
    assert.deepEqual(loadSessions().map((entry) => entry.id), [currentId, 'keep'])
  } finally {
    history.stop()
  }
})

// Verifies reopened turns and future conversation ids remain attached to their original sessions.
test('reopening preserves the current session and appends future turns to the selected one', () => {
  storage()
  saveSessions([session('past', 2)])
  const store = fakeStore([{ id: 'live', role: 'user', text: 'keep current' }])
  const history = createSessionHistory(store, { now: () => 10 })
  const originalId = history.getSnapshot().currentId
  history.attachConversation('original-conversation')
  assert.equal(history.reopen('past', store.setTurns), true)
  history.attachConversation('past-conversation')
  store.setTurns([...store.getState().turns, { id: 'follow-up', role: 'user', text: 'continue' }])
  history.flush()
  assert.equal(history.getSnapshot().currentId, 'past')
  const saved = loadSessions()
  assert.deepEqual(saved.find((entry) => entry.id === 'past').turns.map((turn) => turn.text), ['past', 'continue'])
  assert.equal(saved.find((entry) => entry.id === 'past').conversationId, 'past-conversation')
  assert.equal(saved.find((entry) => entry.id === originalId).conversationId, 'original-conversation')
  assert.equal(saved.find((entry) => entry.id === originalId).turns[0].text, 'keep current')
  // A missing session must not invoke the callback that replaces visible turns.
  assert.equal(history.reopen('missing', () => assert.fail('must not change displayed turns')), false)
  history.stop()
})

// Confirms starting fresh archives existing work without leaking it into the new session.
test('a new session archives the previous conversation without copying its context or bridge ID', () => {
  storage()
  const store = fakeStore([{ id: 'old-turn', role: 'user', text: 'old context' }])
  const history = createSessionHistory(store, { now: () => 10 })
  history.attachConversation('old-bridge-id')
  const oldId = history.getSnapshot().currentId
  history.startNew(store.setTurns)
  assert.notEqual(history.getSnapshot().currentId, oldId)
  assert.deepEqual(store.getState().turns, [])
  assert.equal(history.getSnapshot().sessions.find((entry) => entry.id === oldId).conversationId, 'old-bridge-id')
  history.attachConversation('new-bridge-id')
  store.setTurns([{ id: 'new-turn', role: 'user', text: 'new context' }])
  history.flush()
  const current = loadSessions().find((entry) => entry.id === history.getSnapshot().currentId)
  assert.deepEqual(current.turns.map((turn) => turn.text), ['new context'])
  assert.equal(current.conversationId, 'new-bridge-id')
  history.stop()
})

// Covers active-id precedence, checkpoint matching, newest fallback, and intentional empty state.
test('startup restores the last active session or most recent conversation, but preserves an empty new session', () => {
  const older = { ...session('older', 1), conversationId: 'linked' }
  const latest = session('latest', 2)
  assert.equal(startupSession([older, latest]).id, 'latest')
  assert.equal(startupSession([older, latest], { activeId: 'older' }).id, 'older')
  assert.equal(startupSession([older, latest], { conversationId: 'linked' }).id, 'older')
  assert.equal(startupSession([older, latest], { activeId: 'empty-new-session' }), null)
  assert.equal(startupSession([]), null)
})
