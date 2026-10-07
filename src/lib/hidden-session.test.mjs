import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askHiddenSession } from './hidden-session.ts'

class FakeSocket extends EventTarget {
  static OPEN = 1
  static instances = []
  readyState = 1
  sent = []
  closed = false
  constructor(url) {
    super()
    this.url = url
    FakeSocket.instances.push(this)
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.closed = true; this.readyState = 3 }
  message(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })) }
}

function start() {
  const pending = askHiddenSession('ws://localhost:8787?theme=lcars&conversation=visible-id', 'Check agents', {
    provider: 'claude', model: 'sonnet',
  }, FakeSocket)
  return { pending, socket: FakeSocket.instances.at(-1) }
}

test('hidden session uses a new connection without the visible conversation and only sends its own request', async () => {
  const { pending, socket } = start()
  const url = new URL(socket.url)
  assert.equal(url.searchParams.has('conversation'), false)
  assert.equal(url.searchParams.get('theme'), 'lcars')
  assert.deepEqual(socket.sent, [])
  socket.message({ type: 'conversation', id: 'hidden-id', status: 'new' })
  const request = socket.sent[0]
  assert.equal(request.type, 'ask')
  assert.equal(request.text, 'Check agents')
  socket.message({ type: 'conversation', id: 'hidden-id', status: 'new' })
  socket.message({ type: 'text', ask: 'visible-ask', delta: 'Unrelated chat' })
  socket.message({ type: 'panel', panel: { html: 'Ignored UI' } })
  socket.message({ type: 'text', ask: request.id, delta: 'Two agents ' })
  socket.message({ type: 'done', ask: request.id, text: 'Two agents completed' })
  assert.deepEqual(await pending, { text: 'Two agents' })
  assert.equal(socket.closed, true)
  assert.equal(socket.sent.length, 1)
})

test('hidden session uses final text when no deltas arrive and refuses camera requests', async () => {
  const { pending, socket } = start()
  socket.message({ type: 'conversation', id: 'hidden-id', status: 'new' })
  socket.message({ type: 'capture', id: 'camera' })
  assert.match(socket.sent[1].error, /unavailable/)
  socket.message({ type: 'done', ask: socket.sent[0].id, text: 'No previous work.' })
  assert.deepEqual(await pending, { text: 'No previous work.' })
  assert.equal(socket.closed, true)
})

test('hidden session refuses recovery rather than borrowing a conversation', async () => {
  const { pending, socket } = start()
  socket.message({ type: 'conversation', id: 'visible-id', status: 'restored' })
  await assert.rejects(pending, /fresh startup session/)
  assert.deepEqual(socket.sent, [])
  assert.equal(socket.closed, true)
})

test('hidden session closes on bridge errors and disconnects', async () => {
  for (const failure of ['error', 'close']) {
    const { pending, socket } = start()
    socket.message({ type: 'conversation', id: 'hidden-id', status: 'new' })
    if (failure === 'error') socket.message({ type: 'error', ask: socket.sent[0].id, message: 'Agent tools offline' })
    else socket.dispatchEvent(new Event('close'))
    await assert.rejects(pending, failure === 'error' ? /Agent tools offline/ : /disconnected/)
    assert.equal(socket.closed, true)
  }
})

test('startup status sends only a read-only snapshot request, never a model turn', async () => {
  const pending = askHiddenSession('ws://localhost:8787?conversation=visible', '', { provider: '', model: '', statusOnly: true }, FakeSocket)
  const socket = FakeSocket.instances.at(-1)
  socket.message({ type: 'conversation', id: 'hidden', status: 'new' })
  assert.equal(socket.sent[0].type, 'startup_status')
  socket.message({ type: 'startup_status_reply', requestId: 'other', snapshot: { ignored: true } })
  socket.message({ type: 'startup_status_reply', requestId: socket.sent[0].requestId, snapshot: { observedAt: 'now', board: null } })
  assert.deepEqual(JSON.parse((await pending).text), { observedAt: 'now', board: null })
  assert.deepEqual(socket.sent.map(frame => frame.type), ['startup_status'])
  assert.equal(socket.closed, true)
})