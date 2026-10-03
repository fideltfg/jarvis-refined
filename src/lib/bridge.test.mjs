import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createLogger } from 'vite'

async function withBridge(check) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'jarvis-bridge-test-'))
  const originals = new Map(['window', 'document', 'location', 'localStorage', 'WebSocket', 'setTimeout', 'clearTimeout']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const timers = new Map()
  const sockets = []
  let timerSeq = 0
  let server
  class Socket extends EventTarget {
    static OPEN = 1
    readyState = 0
    sent = []
    constructor() {
      super()
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
  })
})