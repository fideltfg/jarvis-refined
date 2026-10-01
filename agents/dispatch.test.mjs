import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDispatch, isRemote } from './dispatch.mjs'

const task = { id: 't_1', goalId: 'g_1', title: 'Research', kind: 'research' }
const remoteEndpoint = { id: 'rigel', kind: 'remote', label: 'Rigel' }

function storeWith(taskValue = task) {
  let saved = { ...taskValue }
  return {
    getTask: (id) => id === saved.id ? { ...saved } : null,
    saveTask: (next) => { saved = { ...next }; return { ...saved } },
    read: () => ({ ...saved }),
  }
}

test('dispatch selects remote only for a remote lease and passes the remote dependencies', async () => {
  const store = storeWith()
  const calls = []
  const health = { mark: (...args) => calls.push(['health', ...args]) }
  const remote = async (receivedTask, deps) => {
    calls.push(['remote', receivedTask, deps])
    deps.onRemote({ endpointId: deps.endpoint.id, id: 'r_1' })
    return { status: 'done', result: { summary: 'finished' }, failure: null }
  }
  const local = async (...args) => { calls.push(['local', ...args]); return { status: 'done' } }
  const dispatch = createDispatch({ store, health, remote, local, remoteDeps: { fetchFn: 'injected' } })
  const controller = new AbortController()

  const outcome = await dispatch(task, { endpoint: remoteEndpoint, signal: controller.signal })

  assert.deepEqual(outcome, { status: 'done', result: { summary: 'finished' }, failure: null })
  assert.equal(calls[0][0], 'remote')
  assert.deepEqual(calls[0][1], task)
  assert.equal(calls[0][2].endpoint, remoteEndpoint)
  assert.equal(calls[0][2].signal, controller.signal)
  assert.equal(calls[0][2].fetchFn, 'injected')
  assert.deepEqual(store.read().remote, { endpointId: 'rigel', id: 'r_1' })
  assert.equal(calls.some(([kind]) => kind === 'local'), false)
})

test('local dispatch retains worker dependencies and does not invoke remote transport', async () => {
  const store = storeWith()
  const received = []
  const marker = { approvals: true }
  const remote = () => { throw new Error('remote must not run') }
  const local = async (receivedTask, deps) => { received.push({ receivedTask, deps }); return { status: 'done' } }
  const dispatch = createDispatch({ store, local, remote, localDeps: () => marker })

  await dispatch(task, { endpoint: { id: 'cloud', kind: 'anthropic' }, signal: 'signal' })

  assert.deepEqual(received[0].receivedTask, task)
  assert.equal(received[0].deps.approvals, true)
  assert.equal(received[0].deps.signal, 'signal')
  assert.equal(received[0].deps.store, store)
})

test('remote loss marks the leased endpoint unhealthy', async () => {
  const store = storeWith()
  const marked = []
  const dispatch = createDispatch({
    store,
    health: { mark: (...args) => marked.push(args) },
    remote: async (_task, deps) => {
      deps.onLost(new Error('unreachable'))
      return { status: 'failed', failure: { reason: 'remote', detail: 'unreachable' } }
    },
  })

  await dispatch(task, { endpoint: remoteEndpoint })

  assert.deepEqual(marked, [['rigel', false]])
})

test('remote handles are cleared after completion and kept if there was no handle', async () => {
  const store = storeWith({ ...task, remote: { endpointId: 'rigel', id: 'r_old' } })
  const dispatch = createDispatch({ store, remote: async (_task, deps) => { deps.onRemote(null); return { status: 'done' } } })

  await dispatch(task, { endpoint: remoteEndpoint })

  assert.equal(store.read().remote, null)
  assert.equal(isRemote(remoteEndpoint), true)
  assert.equal(isRemote({ kind: 'gateway' }), false)
})
