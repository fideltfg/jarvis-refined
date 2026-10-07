import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createLogger } from 'vite'

async function withBridge(check) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'jarvis-bridge-test-'))
  const originals = new Map(['window', 'document', 'location', 'localStorage', 'sessionStorage', 'WebSocket', 'setTimeout', 'clearTimeout']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const timers = new Map()
  const sockets = []
  let timerSeq = 0
  let server
  class Socket extends EventTarget {
    static OPEN = 1
    readyState = 0
    sent = []
    constructor(url) {
      super()
      this.url = url
      sockets.push(this)
    }
    open() {
      this.readyState = 1
      this.onopen?.()
      this.message({ type: 'ready' })
    }
    message(frame) {
      const event = new Event('message')
      event.data = JSON.stringify(frame)
      this.dispatchEvent(event)
    }
    send(frame) { this.sent.push(JSON.parse(frame)) }
    close() {
      this.readyState = 3
      this.onclose?.()
      this.dispatchEvent(new Event('close'))
    }
  }
  try {
    server = await createServer({
      root: fileURLToPath(new URL('../../', import.meta.url)),
      cacheDir,
      envFile: false,
      customLogger: createLogger('silent'),
      plugins: [{
        name: 'bridge-test-config',
        enforce: 'pre',
        load(id) {
          if (id.endsWith('/src/config.ts')) {
            return 'export const BRIDGE_WS_URL = "ws://localhost:3001"; export const THEME = "jarvis"'
          }
        },
      }],
      server: { watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
    Object.assign(globalThis, {
      window: new EventTarget(),
      document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
      location: { search: '', hostname: 'localhost', port: '5173' },
      localStorage: { getItem: () => null, setItem: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {} },
      WebSocket: Socket,
      setTimeout: (callback, delay) => {
        const id = ++timerSeq
        timers.set(id, { callback, delay })
        return id
      },
      clearTimeout: (id) => timers.delete(id),
    })
    window.setTimeout = globalThis.setTimeout
    const bridge = await server.ssrLoadModule('/src/lib/bridge.ts')
    timers.clear()
    const fire = async (delay) => {
      await Promise.resolve()
      const entry = [...timers].find(([, timer]) => timer.delay === delay)
      assert.ok(entry, `expected a ${delay}ms timer`)
      timers.delete(entry[0])
      entry[1].callback()
      await Promise.resolve()
      await Promise.resolve()
    }
    await check({ bridge, sockets, fire, timers })
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    await server?.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
}

test('a hidden briefing leaves the foreground socket, conversation, storage, and active answer untouched', async () => {
  await withBridge(async ({ bridge, sockets }) => {
    const stored = []
    sessionStorage.setItem = (key, value) => stored.push([key, value])
    const conversations = []
    const panels = []
    bridge.watchConversation((id) => conversations.push(id))
    bridge.watchPanels((panel) => panels.push(panel))
    const warm = bridge.warmBridge()
    sockets[0].open()
    sockets[0].message({ type: 'conversation', id: 'foreground-id', status: 'restored' })
    await warm
    const foregroundText = []
    const foreground = bridge.ask('Continue the project', {
      onText: (text) => foregroundText.push(text), onTool: () => {},
    })
    await Promise.resolve()
    const visibleRequest = sockets[0].sent.find((frame) => frame.type === 'ask')
    const storedBefore = structuredClone(stored)
    const hidden = bridge.askHidden('Check old agents')
    assert.equal(sockets.length, 2)
    assert.equal(new URL(sockets[1].url).searchParams.has('conversation'), false)
    sockets[1].open()
    sockets[1].message({ type: 'conversation', id: 'hidden-id', status: 'new' })
    const hiddenRequest = sockets[1].sent.find((frame) => frame.type === 'ask')
    sockets[1].message({ type: 'panel', panel: { id: 'ignored' } })
    sockets[1].message({ type: 'text', ask: hiddenRequest.id, delta: 'Agents completed' })
    sockets[1].message({ type: 'done', ask: hiddenRequest.id })
    assert.deepEqual(await hidden, { text: 'Agents completed' })
    assert.equal(bridge.currentConversationId(), 'foreground-id')
    assert.deepEqual(conversations, ['foreground-id'])
    assert.deepEqual(stored, storedBefore)
    assert.deepEqual(panels, [])
    assert.deepEqual(foregroundText, [])
    assert.equal(bridge.isConnected(), true)
    assert.equal(sockets[1].readyState, 3)
    assert.deepEqual(sockets[1].sent.map((frame) => frame.type), ['ask'])
    assert.equal(sockets[0].sent.some((frame) => frame.type === 'interrupt'), false)
    sockets[0].message({ type: 'text', ask: visibleRequest.id, delta: 'Project continues' })
    sockets[0].message({ type: 'done', ask: visibleRequest.id })
    assert.equal((await foreground).text, 'Project continues')
    assert.deepEqual(foregroundText, ['Project continues'])
  })
})

test('hidden timeout interrupts only the isolated request and never retries it', async () => {
  await withBridge(async ({ bridge, sockets, fire }) => {
    const hidden = bridge.askHidden('Check old agents')
    sockets[0].open()
    sockets[0].message({ type: 'conversation', id: 'hidden-id', status: 'new' })
    const failed = assert.rejects(hidden, /timed out/)
    sockets[0].message({ type: 'pong' })
    await fire(120_000)
    await failed
    assert.deepEqual(sockets[0].sent.map((frame) => frame.type), ['ask', 'interrupt'])
    assert.equal(sockets[0].readyState, 3)
    assert.equal(sockets.length, 1)
  })
})

test('a failed reconnect schedules another attempt and recovers without a new question', async () => {
  await withBridge(async ({ bridge, sockets, fire }) => {
    const states = []
    bridge.watchConnection((state) => states.push(state))
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    sockets[0].close()
    await fire(500)
    sockets[1].close()
    await fire(1000)
    sockets[2].open()
    assert.equal(bridge.isConnected(), true)
    assert.deepEqual(states, ['open', 'lost', 'reconnected'])
  })
})

test('schedule mutations await correlated acknowledgements and surface service errors', async () => {
  await withBridge(async ({ bridge, sockets }) => {
    await assert.rejects(bridge.scheduleRequest({ action: 'list' }), /disconnected/)
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    const requested = bridge.scheduleRequest({ action: 'list' })
    const sent = sockets[0].sent.at(-1)
    assert.equal(sent.type, 'schedule_request')
    sockets[0].message({ type: 'schedule_reply', requestId: 'unrelated', result: [] })
    sockets[0].message({ type: 'schedule_reply', requestId: sent.requestId, result: [{ id: 's_1' }] })
    assert.deepEqual(await requested, [{ id: 's_1' }])
    const failed = bridge.scheduleRequest({ action: 'run', id: 's_1' })
    sockets[0].message({ type: 'schedule_reply', requestId: sockets[0].sent.at(-1).requestId, error: 'Previous run is active' })
    await assert.rejects(failed, /Previous run/)
    const disconnected = bridge.scheduleRequest({ action: 'list' })
    sockets[0].close()
    await assert.rejects(disconnected, /may have been saved/)
  })
})

test('schedule requests time out without retrying a possibly saved mutation', async () => {
  await withBridge(async ({ bridge, sockets, fire }) => {
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    const requested = bridge.scheduleRequest({ action: 'run', id: 's_1' })
    const check = assert.rejects(requested, /timed out/)
    await fire(30000)
    await fire(30000)
    await check
    assert.equal(sockets[0].sent.filter((frame) => frame.type === 'schedule_request').length, 1)
  })
})

test('a silent open socket is replaced when its heartbeat is unanswered', async () => {
  await withBridge(async ({ bridge, sockets, fire }) => {
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    await fire(30_000)
    assert.deepEqual(sockets[0].sent, [{ type: 'ping' }])
    await fire(10_000)
    assert.equal(bridge.isConnected(), false)
    await fire(500)
    sockets[1].open()
    assert.equal(bridge.isConnected(), true)
  })
})

test('returning to the tab probes the existing session without replacing a healthy socket', async () => {
  await withBridge(async ({ bridge, sockets, timers }) => {
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    document.dispatchEvent(new Event('visibilitychange'))
    assert.deepEqual(sockets[0].sent, [{ type: 'ping' }])
    sockets[0].message({ type: 'pong' })
    assert.ok(![...timers.values()].some((timer) => timer.delay === 10_000))
    assert.equal(sockets.length, 1)
    assert.equal(bridge.isConnected(), true)
  })
})

test('heartbeat replies do not postpone the timeout for a stalled answer', async () => {
  await withBridge(async ({ bridge, sockets, fire, timers }) => {
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    const answer = bridge.ask('hello', { onText() {}, onTool() {} })
    await Promise.resolve()
    const deadline = [...timers].find(([, timer]) => timer.delay === 120_000)[0]
    sockets[0].message({ type: 'pong' })
    assert.ok(timers.has(deadline))
    const rejected = assert.rejects(answer, /turn was lost/)
    await fire(120_000)
    await rejected
    assert.deepEqual(sockets[0].sent.at(-1), { type: 'interrupt' })
  })
})

test('frames from an older turn do not postpone a stalled answer timeout', async () => {
  await withBridge(async ({ bridge, sockets, timers }) => {
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    const answer = bridge.ask('hello', { onText() {}, onTool() {} })
    await Promise.resolve()
    const deadline = [...timers].find(([, timer]) => timer.delay === 120_000)[0]
    sockets[0].message({ type: 'text', ask: 'old-turn', delta: 'late answer' })
    assert.ok(timers.has(deadline))
    sockets[0].message({ type: 'done', ask: sockets[0].sent.at(-1).id, text: 'hello' })
    assert.equal((await answer).text, 'hello')
  })
})

test('real progress refreshes the current turn deadline until its answer arrives', async () => {
  await withBridge(async ({ bridge, sockets, timers }) => {
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    const answer = bridge.ask('slow tool', { onText() {}, onTool() {} })
    await Promise.resolve()
    const id = sockets[0].sent.at(-1).id
    const deadline = [...timers].find(([, timer]) => timer.delay === 120_000)[0]
    sockets[0].message({ type: 'progress', ask: id })
    assert.equal(timers.has(deadline), false)
    assert.ok([...timers.values()].some((timer) => timer.delay === 120_000))
    sockets[0].message({ type: 'done', ask: id, text: 'finished' })
    assert.equal((await answer).text, 'finished')
    assert.equal([...timers.values()].some((timer) => timer.delay === 120_000), false)
  })
})

test('reconnect sends the same conversation ID and waits for confirmed recovery', async () => {
  await withBridge(async ({ bridge, sockets, fire }) => {
    const states = []
    const stored = []
    sessionStorage.setItem = (...entry) => stored.push(entry)
    bridge.watchConnection((state) => states.push(state))
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    sockets[0].message({ type: 'conversation', id: 'saved-conversation', status: 'new' })
    assert.equal(stored[0][1], 'saved-conversation')
    sockets[0].close()
    await fire(500)
    assert.equal(new URL(sockets[1].url).searchParams.get('conversation'), 'saved-conversation')
    sockets[1].open()
    assert.deepEqual(states, ['open', 'lost', 'reconnected'])
    sockets[1].message({ type: 'conversation', id: 'saved-conversation', status: 'restored' })
    assert.equal(states.at(-1), 'restored')
    assert.deepEqual(sockets[1].sent, [])
  })
})

test('a missing checkpoint is reported instead of claiming recovery succeeded', async () => {
  await withBridge(async ({ bridge, sockets }) => {
    const states = []
    bridge.watchConnection((state) => states.push(state))
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    sockets[0].message({ type: 'conversation', id: 'missing-conversation', status: 'unavailable' })
    assert.equal(states.at(-1), 'reset')
  })
})

test('reopening older history restores its transcript without submitting a model request', async () => {
  await withBridge(async ({ bridge, sockets }) => {
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    sockets[0].message({ type: 'conversation', id: 'current', status: 'new' })
    const turns = [{ id: 'past-turn', role: 'user', text: 'remember cobalt', at: 1 }]
    const reopened = bridge.openConversation({ id: 'past', startedAt: 1, updatedAt: 1, turns })
    sockets[1].open()
    sockets[1].message({ type: 'conversation', id: 'reopened', status: 'new' })
    await new Promise((resolve) => setImmediate(resolve))
    const request = sockets[1].sent.at(-1)
    assert.equal(request.type, 'restore_history')
    assert.deepEqual(request.turns, turns)
    sockets[1].message({ type: 'history_restored', id: request.id })
    assert.equal(await reopened, 'reopened')
    assert.ok(sockets.every((socket) => socket.sent.every((frame) => frame.type !== 'ask')))
  })
})

test('reopening a linked checkpoint uses the saved conversation rather than seeding duplicates', async () => {
  await withBridge(async ({ bridge, sockets }) => {
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    const reopened = bridge.openConversation({ id: 'past', conversationId: 'linked', startedAt: 1, updatedAt: 1, turns: [] })
    assert.equal(new URL(sockets[1].url).searchParams.get('conversation'), 'linked')
    sockets[1].open()
    sockets[1].message({ type: 'conversation', id: 'linked', status: 'restored' })
    assert.equal(await reopened, 'linked')
    assert.deepEqual(sockets[1].sent, [])
  })
})

test('failed history restoration rolls back to the original conversation', async () => {
  await withBridge(async ({ bridge, sockets }) => {
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    sockets[0].message({ type: 'conversation', id: 'original', status: 'new' })
    const rejected = assert.rejects(bridge.openConversation({ id: 'past', startedAt: 1, updatedAt: 1, turns: [] }), /cannot restore/)
    sockets[1].open()
    sockets[1].message({ type: 'conversation', id: 'new', status: 'new' })
    await new Promise((resolve) => setImmediate(resolve))
    sockets[1].message({ type: 'history_restore_error', id: sockets[1].sent.at(-1).id, message: 'cannot restore' })
    await rejected
    assert.equal(bridge.currentConversationId(), 'original')
  })
})

test('new session opens a fresh bridge conversation without restoring or submitting old turns', async () => {
  await withBridge(async ({ bridge, sockets }) => {
    const warm = bridge.warmBridge()
    sockets[0].open()
    await warm
    sockets[0].message({ type: 'conversation', id: 'previous', status: 'new' })
    const fresh = bridge.startNewConversation()
    assert.equal(new URL(sockets[1].url).searchParams.has('conversation'), false)
    sockets[1].open()
    sockets[1].message({ type: 'conversation', id: 'fresh', status: 'new' })
    assert.equal(await fresh, 'fresh')
    assert.deepEqual(sockets[1].sent, [])
    assert.equal(bridge.currentConversationId(), 'fresh')
  })
})