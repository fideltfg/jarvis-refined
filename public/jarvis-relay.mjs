#!/usr/bin/env node
/**
 * JARVIS browser relay.
 *
 * Run this on the machine whose Chrome JARVIS should drive, when JARVIS itself
 * lives on a server. It dials out to the bridge and pipes bytes between that
 * connection and the Claude extension's native host on this machine — nothing
 * more. It does not read, keep or change what passes through.
 *
 *   node jarvis-relay.mjs wss://server:5173/bridge/relay --token <token>
 *
 * One file, no dependencies, Node 22 or newer. Needs Chrome open with the
 * Claude extension, and Claude Code installed here with its Chrome integration
 * enabled (that is what provides the native host).
 *
 * Options (each also readable from the environment):
 *   --token <t>     JARVIS_RELAY_TOKEN   the secret from `npm run relay:token`
 *   --ca <file>     JARVIS_RELAY_CA      trust this certificate (self-signed servers)
 *   --insecure                           do not verify the server certificate
 *   --socket <path> JARVIS_RELAY_SOCKET  native-host socket or pipe, if not found
 *
 * Whoever holds the token and this connection can act in your signed-in
 * browser. Prefer --ca over --insecure on a network you do not control.
 */

import { createConnection } from 'node:net'
import { readdir, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import process from 'node:process'

const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const url = argv.find((a) => /^wss?:\/\//.test(a)) ?? process.env.JARVIS_RELAY_URL
const token = flag('token') ?? process.env.JARVIS_RELAY_TOKEN
const ca = flag('ca') ?? process.env.JARVIS_RELAY_CA
const fixedSocket = flag('socket') ?? process.env.JARVIS_RELAY_SOCKET

if (!url || !token) {
  console.error('usage: node jarvis-relay.mjs wss://server:5173/bridge/relay --token <token> [--ca cert.crt | --insecure]')
  process.exit(2)
}
if (typeof WebSocket === 'undefined') {
  console.error('This relay needs Node 22 or newer.')
  process.exit(2)
}
if (argv.includes('--insecure')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  process.removeAllListeners('warning')
} else if (ca) {
  if (typeof tls.setDefaultCACertificates !== 'function') {
    console.error('--ca needs a newer Node. Set NODE_EXTRA_CA_CERTS to the certificate file instead.')
    process.exit(2)
  }
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), readFileSync(ca, 'utf8')])
}

const user = userInfo().username

/**
 * Where the extension's native host listens. A named pipe on Windows; on
 * macOS and Linux a directory of per-process sockets, of which the newest is
 * the live one (0.sock is a symlink that goes stale, so it is tried last).
 */
async function findSocket() {
  if (fixedSocket) return fixedSocket
  if (process.platform === 'win32') {
    // The pipe name below is an assumption about the native host, so look at
    // what is actually there before falling back to it.
    const expected = `claude-mcp-browser-bridge-${user}`
    let pipes = []
    try {
      pipes = (await readdir('\\\\.\\pipe\\')).filter((name) => /claude.*browser/i.test(name))
    } catch {
      /* listing pipes is best-effort */
    }
    const name = pipes.find((p) => p === expected) ?? pipes[0] ?? expected
    return `\\\\.\\pipe\\${name}`
  }
  const dir = `/tmp/claude-mcp-browser-bridge-${user}`
  let names
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const found = []
  for (const name of names) {
    if (!name.endsWith('.sock')) continue
    try {
      const info = await stat(join(dir, name))
      found.push({ path: join(dir, name), at: info.mtimeMs, fallback: name === '0.sock' })
    } catch {
      /* vanished mid-scan */
    }
  }
  found.sort((a, b) => a.fallback - b.fallback || b.at - a.at)
  return found[0]?.path ?? null
}

const NOT_RUNNING =
  'the Claude browser extension is not running on that machine — open Chrome with the extension enabled'

let retry = 1_000

function connect() {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  /** Native-host connections by the id the bridge gave them. */
  const socks = new Map()
  const tell = (message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }

  async function open(id) {
    const path = await findSocket()
    if (!path) {
      console.error('[relay] no native-host socket found — is Chrome open with the Claude extension?')
      return tell({ type: 'failed', id, error: NOT_RUNNING })
    }
    const sock = createConnection(path)
    let up = false
    sock.on('connect', () => {
      up = true
      socks.set(id, sock)
      tell({ type: 'opened', id })
    })
    sock.on('data', (chunk) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const framed = Buffer.allocUnsafe(4 + chunk.length)
      framed.writeUInt32LE(id, 0)
      chunk.copy(framed, 4)
      ws.send(framed)
    })
    sock.on('error', (err) => {
      console.error(`[relay] could not use ${path}: ${err.code ?? err.message}`)
      if (!up) tell({ type: 'failed', id, error: err.code === 'ENOENT' ? NOT_RUNNING : err.message })
    })
    sock.on('close', () => {
      if (socks.get(id) === sock) {
        socks.delete(id)
        tell({ type: 'closed', id })
      }
    })
  }

  ws.addEventListener('open', () => tell({ type: 'hello', token, host: hostname() }))

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      const bytes = Buffer.from(event.data)
      if (bytes.length >= 4) socks.get(bytes.readUInt32LE(0))?.write(bytes.subarray(4))
      return
    }
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.type === 'ready') {
      retry = 1_000
      console.log(`[relay] linked to ${url} — JARVIS can use this browser.`)
    } else if (message.type === 'open') {
      void open(message.id)
    } else if (message.type === 'close') {
      const sock = socks.get(message.id)
      socks.delete(message.id)
      sock?.destroy()
    }
  })

  ws.addEventListener('close', (event) => {
    for (const sock of socks.values()) sock.destroy()
    socks.clear()
    if (event.code === 4401) {
      console.error('[relay] the bridge refused the token. Check --token against `npm run relay:token`.')
      process.exit(1)
    }
    if (event.code === 4409) {
      console.error('[relay] another relay on this machine took over. Stopping.')
      process.exit(0)
    }
    console.log(`[relay] not connected; retrying in ${Math.round(retry / 1000)}s`)
    setTimeout(connect, retry)
    retry = Math.min(retry * 2, 15_000)
  })

  // The close event that follows does the work; this only keeps an unreachable
  // server from being an uncaught error.
  ws.addEventListener('error', () => {})
}

connect()
