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
 *   --background                         run without an open terminal
 *   --status / --stop                     inspect or stop the background relay
 *   --background-dir <path>               override the private state/log directory
 *
 * Whoever holds the token and this connection can act in your signed-in
 * browser. Prefer --ca over --insecure on a network you do not control.
 */

import { createConnection, createServer } from 'node:net'
import { readdir, stat } from 'node:fs/promises'
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, statSync, renameSync } from 'node:fs'
import { hostname, homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

const backgroundDirectory = resolve(flag('background-dir') ?? (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? homedir(), 'JarvisRefined', 'Relay')
  : join(homedir(), '.local', 'state', 'jarvis-relay')))
const stateFile = join(backgroundDirectory, 'background.json')
const worker = argv.includes('--background-worker')

async function control(command) {
  let state
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (state.starting) {
    try { process.kill(state.pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return null
      throw error
    }
    throw new Error('Background startup is already in progress. Try again shortly.')
  }
  return await new Promise((done, fail) => {
    const socket = createConnection(state.endpoint)
    let response = ''
    socket.setTimeout(2_000, () => socket.destroy(new Error('Background relay did not respond.')))
    socket.on('connect', () => socket.write(`${JSON.stringify({ command, secret: state.secret })}\n`))
    socket.on('data', (chunk) => { response += chunk })
    socket.on('end', () => {
      try { done(JSON.parse(response)) } catch { fail(new Error('Invalid background relay response.')) }
    })
    socket.on('error', (error) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') done(null)
      else fail(error)
    })
  })
}

if (argv.includes('--status') || argv.includes('--stop')) {
  try {
    const stopping = argv.includes('--stop')
    const result = await control(stopping ? 'stop' : 'status')
    console.log(result ? (stopping ? '[relay] background relay stopped.' : `[relay] background relay running (PID ${result.pid}, ${result.linked ? 'linked' : 'reconnecting'}). Logs: ${backgroundDirectory}`)
      : '[relay] background relay is not running.')
    process.exit(result || stopping ? 0 : 1)
  } catch (error) {
    console.error(`[relay] ${error.message}`)
    process.exit(1)
  }
}

if (!url || !token) {
  console.error('usage: node jarvis-relay.mjs wss://server:5173/bridge/relay --token <token> [--ca cert.crt | --insecure]')
  process.exit(2)
}
if (typeof WebSocket === 'undefined') {
  console.error('This relay needs Node 22 or newer.')
  process.exit(2)
}
if (argv.includes('--background')) {
  let child
  let log
  let reservation
  let launchLock
  const lockFile = join(backgroundDirectory, 'launch.lock')
  const releaseReservation = () => {
    try {
      if (reservation && JSON.parse(readFileSync(stateFile, 'utf8')).secret === reservation) rmSync(stateFile, { force: true })
    } catch { }
  }
  try {
    const address = new URL(url)
    if (!['ws:', 'wss:'].includes(address.protocol) || address.username || address.password || address.hash) {
      throw new Error('Use a ws:// or wss:// relay URL without embedded credentials or a fragment.')
    }
    if (ca) readFileSync(resolve(ca))
    if (await control('status')) throw new Error('A background relay is already running. Use --stop first.')
    mkdirSync(backgroundDirectory, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') {
      const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
      const sid = identity.stdout?.match(/S-1-5-[0-9-]+/)?.[0]
      if (identity.status !== 0 || !sid) throw new Error('Could not identify the Windows user.')
      const acl = spawnSync('icacls.exe', [backgroundDirectory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true })
      if (acl.status !== 0) throw new Error('Could not protect the background relay directory.')
    } else chmodSync(backgroundDirectory, 0o700)
    try { launchLock = openSync(lockFile, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = Number(readFileSync(lockFile, 'utf8'))
      if (!Number.isSafeInteger(owner) || owner < 1) throw new Error('Background startup is already in progress.')
      try { process.kill(owner, 0) } catch (failure) {
        if (failure.code !== 'ESRCH') throw failure
        rmSync(lockFile, { force: true })
        launchLock = openSync(lockFile, 'wx', 0o600)
      }
      if (launchLock === undefined) throw new Error('Background startup is already in progress.')
    }
    writeFileSync(launchLock, String(process.pid))
    process.once('exit', () => {
      closeSync(launchLock)
      try { if (readFileSync(lockFile, 'utf8') === String(process.pid)) rmSync(lockFile, { force: true }) } catch { }
    })
    if (await control('status')) throw new Error('A background relay is already running. Use --stop first.')
    rmSync(stateFile, { force: true })
    const descriptor = openSync(stateFile, 'wx', 0o600)
    reservation = randomBytes(32).toString('hex')
    try { writeFileSync(descriptor, JSON.stringify({ starting: true, pid: process.pid, secret: reservation })) }
    finally { closeSync(descriptor) }
    const logFile = join(backgroundDirectory, 'relay.log')
    try {
      if (statSync(logFile).size > 5 * 1024 * 1024) {
        rmSync(`${logFile}.previous`, { force: true })
        renameSync(logFile, `${logFile}.previous`)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    log = openSync(logFile, 'a', 0o600)
    if (process.platform !== 'win32') chmodSync(logFile, 0o600)
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--background-worker', '--background-dir', backgroundDirectory], {
      detached: true, windowsHide: true, stdio: ['ignore', log, log, 'ipc'],
      env: { ...process.env, JARVIS_RELAY_URL: url, JARVIS_RELAY_TOKEN: token,
        JARVIS_RELAY_CA: ca ? resolve(ca) : '', JARVIS_RELAY_SOCKET: fixedSocket ?? '',
        JARVIS_RELAY_BACKGROUND_SECRET: reservation,
        JARVIS_RELAY_BACKGROUND_INSECURE: argv.includes('--insecure') ? '1' : '0' },
    })
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('Background startup timed out. Check relay.log.')), 5_000)
      child.once('message', (message) => {
        clearTimeout(timer)
        if (message.ready) done()
        else fail(new Error('Background startup failed. Check relay.log.'))
      })
      child.once('error', (error) => { clearTimeout(timer); fail(error) })
      child.once('exit', () => { clearTimeout(timer); fail(new Error('Background startup failed. Check relay.log.')) })
    })
    child.disconnect()
    child.unref()
    reservation = null
    console.log(`[relay] running in the background (PID ${child.pid}). You can close this terminal. Logs: ${logFile}`)
    process.exit(0)
  } catch (error) {
    child?.kill()
    releaseReservation()
    console.error(`[relay] ${error.message}`)
    process.exit(1)
  } finally {
    if (log !== undefined) closeSync(log)
  }
}
if (argv.includes('--insecure') || (worker && process.env.JARVIS_RELAY_BACKGROUND_INSECURE === '1')) {
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

if (worker) {
  const logFile = join(backgroundDirectory, 'relay.log')
  const writeLog = (...values) => {
    try {
      if (statSync(logFile).size > 5 * 1024 * 1024) {
        rmSync(`${logFile}.previous`, { force: true })
        renameSync(logFile, `${logFile}.previous`)
      }
      appendFileSync(logFile, `${new Date().toISOString()} ${values.join(' ')}\n`, { mode: 0o600 })
    } catch { }
  }
  console.log = writeLog
  console.error = writeLog
}

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
let linked = false

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
      linked = true
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
    linked = false
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

if (worker) {
  const secret = process.env.JARVIS_RELAY_BACKGROUND_SECRET
  if (!process.send || !/^[a-f0-9]{64}$/.test(secret ?? '')) {
    console.error('[relay] --background-worker is reserved for internal use. Use --background.')
    process.exit(2)
  }
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\jarvis-relay-${secret}` : join(backgroundDirectory, `control-${secret.slice(0, 16)}.sock`)
  const server = createServer((socket) => {
    let request = ''
    let handled = false
    socket.setTimeout(2_000, () => socket.destroy())
    socket.on('error', () => {})
    const respond = () => {
      if (handled) return
      handled = true
      let message
      try { message = JSON.parse(request) } catch { socket.end(); return }
      if (message.secret !== secret || !['status', 'stop'].includes(message.command)) { socket.end(); return }
      socket.end(JSON.stringify({ pid: process.pid, linked }), () => {
        if (message.command === 'stop') process.exit(0)
      })
    }
    socket.on('data', (chunk) => {
      if (handled) return
      request += chunk
      if (request.length > 1024) { socket.destroy(); return }
      const boundary = request.indexOf('\n')
      if (boundary !== -1) {
        request = request.slice(0, boundary)
        respond()
      }
    })
    socket.on('end', respond)
  })
  try {
    await new Promise((done, fail) => {
      server.once('error', fail)
      server.listen(endpoint, done)
    })
    if (JSON.parse(readFileSync(stateFile, 'utf8')).secret !== secret) throw new Error('Startup reservation changed.')
    writeFileSync(stateFile, JSON.stringify({ endpoint, secret, pid: process.pid }), { mode: 0o600 })
    process.on('exit', () => {
      try {
        if (JSON.parse(readFileSync(stateFile, 'utf8')).secret === secret) rmSync(stateFile, { force: true })
        if (process.platform !== 'win32') rmSync(endpoint, { force: true })
      } catch { }
    })
    process.send?.({ ready: true })
  } catch {
    console.error('[relay] could not create the private background control channel.')
    process.exit(1)
  }
}

connect()
