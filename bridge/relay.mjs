import { EventEmitter } from 'node:events'
import { timingSafeEqual } from 'node:crypto'

/**
 * Browsers on other machines.
 *
 * chrome.mjs reaches the Claude extension through a socket its native host
 * opens on the machine Chrome runs on. That is fine while the bridge and the
 * browser share a desk, and useless once JARVIS lives on a server: the socket
 * is over there, and nothing a web page can do will reach it.
 *
 * So the machine with the browser runs a small relay (public/jarvis-relay.mjs)
 * that dials *out* to this bridge and pipes bytes between the WebSocket and its
 * local native-host socket. Outbound, because a laptop can always reach the
 * server and the server can rarely reach a laptop. The relay never parses what
 * it carries — the framing and the protocol stay in chrome.mjs, in one place.
 *
 * Wire format, after a `{type:'hello', token, host}` / `{type:'ready'}` pair:
 *
 *   bridge → relay   {type:'open', id}       dial the native host
 *   relay → bridge   {type:'opened', id}     or {type:'failed', id, error}
 *   either way       binary: 4-byte LE id + bytes for that connection
 *   bridge → relay   {type:'close', id}      hang up
 *   relay → bridge   {type:'closed', id}     the native host hung up
 *
 * The id matters because chrome.mjs abandons a connection whenever a reply is
 * late, and a late reply arriving on the next connection would be read as the
 * answer to a different question.
 *
 * A relay hands this bridge the user's signed-in browser, so registering one
 * takes a shared token (JARVIS_RELAY_TOKEN). Without a token the endpoint is
 * off entirely.
 */

const HELLO_TIMEOUT_MS = 5_000
const OPEN_TIMEOUT_MS = 4_000
const PING_MS = 30_000

/** One native-host connection on the far machine. Quacks like a net.Socket. */
class RelayConn extends EventEmitter {
  constructor(relay, id) {
    super()
    this.relay = relay
    this.id = id
    this.destroyed = false
  }

  write(bytes, done) {
    if (this.destroyed) return done?.(new Error('the browser relay connection is closed'))
    const head = Buffer.alloc(4)
    head.writeUInt32LE(this.id, 0)
    this.relay.ws.send(Buffer.concat([head, bytes]), { binary: true }, done)
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.relay.conns.delete(this.id)
    this.relay.tell({ type: 'close', id: this.id })
  }
}

class Relay {
  constructor(ws, { ip, host }) {
    this.ws = ws
    this.ip = ip
    this.host = host
    this.conns = new Map()
    this.opening = new Map()
    this.nextId = 1
  }

  tell(message) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message))
  }

  /** Ask the far machine to dial its native host. */
  open() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== this.ws.OPEN) {
        return reject(new Error('the browser relay has disconnected'))
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.opening.delete(id)
        this.tell({ type: 'close', id })
        reject(new Error('the browser relay did not answer'))
      }, OPEN_TIMEOUT_MS)
      this.opening.set(id, {
        resolve: () => {
          clearTimeout(timer)
          const conn = new RelayConn(this, id)
          this.conns.set(id, conn)
          resolve(conn)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      this.tell({ type: 'open', id })
    })
  }

  onMessage(data, isBinary) {
    if (isBinary) {
      if (data.length < 4) return
      const conn = this.conns.get(data.readUInt32LE(0))
      if (conn && !conn.destroyed) conn.emit('data', data.subarray(4))
      return
    }
    let message
    try {
      message = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    const pending = this.opening.get(message?.id)
    if (message?.type === 'opened' && pending) {
      this.opening.delete(message.id)
      pending.resolve()
    } else if (message?.type === 'failed' && pending) {
      this.opening.delete(message.id)
      pending.reject(new Error(String(message.error ?? 'the browser extension is not running there')))
    } else if (message?.type === 'closed') {
      const conn = this.conns.get(message.id)
      if (!conn) return
      this.conns.delete(message.id)
      conn.destroyed = true
      conn.emit('close')
    }
  }

  /** The relay itself went away: everything riding on it is over. */
  end() {
    for (const pending of this.opening.values()) {
      pending.reject(new Error('the browser relay has disconnected'))
    }
    this.opening.clear()
    for (const conn of this.conns.values()) {
      conn.destroyed = true
      conn.emit('close')
    }
    this.conns.clear()
  }
}

function sameToken(given, expected) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * @param {{ token?: string, log?: (line: string) => void }} options
 */
export function createRelayHub({ token, log = console.log } = {}) {
  /** One relay per machine, keyed by the address it connected from. */
  const relays = new Map()

  return {
    enabled: Boolean(token),

    /** The relay running on the machine at this address, if any. */
    for: (ip) => relays.get(ip) ?? null,

    /** The only relay connected, when there is exactly one. */
    sole: () => (relays.size === 1 ? relays.values().next().value : null),

    /** Take a freshly upgraded socket through the handshake. */
    attach(ws, ip) {
      let relay = null
      const hello = setTimeout(() => ws.close(4401, 'no hello'), HELLO_TIMEOUT_MS)
      const ping = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.ping()
      }, PING_MS)

      ws.on('message', (data, isBinary) => {
        if (relay) return relay.onMessage(data, isBinary)
        clearTimeout(hello)
        let message = null
        try {
          message = isBinary ? null : JSON.parse(data.toString('utf8'))
        } catch {
          /* falls through to the refusal below */
        }
        if (message?.type !== 'hello' || !token || !sameToken(message.token, token)) {
          log(`[jarvis] refused a browser relay from ${ip}: bad token`)
          return ws.close(4401, 'bad token')
        }
        relay = new Relay(ws, { ip, host: String(message.host ?? ip).slice(0, 80) })
        // A machine has one browser. A second relay from the same address is
        // the first one restarted, so the newcomer wins.
        relays.get(ip)?.ws.close(4409, 'replaced')
        relays.set(ip, relay)
        ws.send(JSON.stringify({ type: 'ready' }))
        log(`[jarvis] browser relay connected from ${relay.host} (${ip})`)
      })

      const gone = () => {
        clearTimeout(hello)
        clearInterval(ping)
        if (!relay) return
        relay.end()
        if (relays.get(ip) === relay) {
          relays.delete(ip)
          log(`[jarvis] browser relay from ${relay.host} (${ip}) disconnected`)
        }
      }
      ws.on('close', gone)
      ws.on('error', gone)
    },
  }
}

/**
 * The address a request really came from.
 *
 * The face and the relay both arrive through Vite's /bridge proxy, so the
 * socket's own peer is loopback and the truth is in X-Forwarded-For. That
 * header is only believed from loopback — anything arriving directly could
 * write whatever it liked there.
 */
export function clientAddress(req) {
  const plain = (ip) => String(ip ?? '').trim().replace(/^::ffff:/, '')
  const peer = plain(req.socket?.remoteAddress)
  const loopback = peer === '127.0.0.1' || peer === '::1'
  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0]
  return loopback && forwarded.trim() ? plain(forwarded) : peer
}
