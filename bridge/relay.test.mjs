import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'

import { ChromeLink, chromeTarget } from './chrome.mjs'
import { clientAddress, createRelayHub } from './relay.mjs'

/** A stand-in native host: answers every framed request with its tool name. */
function fakeNativeHost(path) {
  const server = net.createServer((sock) => {
    let buffer = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0)
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
        buffer = buffer.subarray(4 + length)
        const body = Buffer.from(
          JSON.stringify({ result: { content: [{ type: 'text', text: `ran ${request.params.tool}` }] } }),
        )
        const head = Buffer.alloc(4)
        head.writeUInt32LE(body.length, 0)
        sock.write(Buffer.concat([head, body]))
      }
    })
  })
  return new Promise((resolve) => server.listen(path, () => resolve(server)))
}

async function bridgeWith(hub) {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => hub.attach(ws, clientAddress(req)))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, wss, url: `ws://127.0.0.1:${server.address().port}/relay` }
}

const waitFor = async (check, ms = 5_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out waiting')
}

test('a relay carries extension calls to a browser on another machine', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-relay-'))
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\jarvis-relay-test-${process.pid}` : join(dir, 'host.sock')
  const host = await fakeNativeHost(socketPath)
  const hub = createRelayHub({ token: 'secret', log: () => {} })
  const bridge = await bridgeWith(hub)
  const relay = spawn(
    process.execPath,
    ['public/jarvis-relay.mjs', bridge.url, '--token', 'secret', '--socket', socketPath],
    { stdio: 'ignore' },
  )
  t.after(() => {
    relay.kill()
    for (const client of bridge.wss.clients) client.terminate()
    bridge.server.close()
    host.close()
    rmSync(dir, { recursive: true, force: true })
  })

  await waitFor(() => hub.sole())

  // The face came from an address with no relay of its own and the bridge has
  // no local browser, so the one relay there is gets the call.
  const link = await chromeTarget({ hub, clientIp: '10.9.9.9' })()
  assert.equal(await link.available(), true)
  const reply = await link.call('tabs_context_mcp', {})
  assert.equal(reply.result.content[0].text, 'ran tabs_context_mcp')

  // A dropped connection is redialled through the same relay.
  link.reset()
  const again = await link.call('get_page_text', {})
  assert.equal(again.result.content[0].text, 'ran get_page_text')

  relay.kill()
  await waitFor(() => !hub.sole())
  assert.equal(await link.available(), false)
})

test('a relay with the wrong token is turned away', async (t) => {
  const hub = createRelayHub({ token: 'secret', log: () => {} })
  const bridge = await bridgeWith(hub)
  t.after(() => bridge.server.close())

  const ws = new WebSocket(bridge.url)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token: 'wrong' })))
  const [event] = await once(ws, 'close')
  assert.equal(event.code, 4401)
  assert.equal(hub.sole(), null)
})

test('downloaded relay runs in the background, forwards calls and stops through private control', { timeout: 15_000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-background-'))
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\jarvis-background-test-${process.pid}` : join(directory, 'host.sock')
  const host = await fakeNativeHost(socketPath)
  const hub = createRelayHub({ token: 'private-background-token', log: () => {} })
  const bridge = await bridgeWith(hub)
  const command = (...args) => new Promise((done, fail) => {
    const child = spawn(process.execPath, ['public/jarvis-relay.mjs', '--background-dir', directory, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', fail)
    child.on('exit', (code) => done({ code, output }))
  })
  context.after(async () => {
    await command('--stop')
    for (const client of bridge.wss.clients) client.terminate()
    bridge.wss.close()
    bridge.server.close()
    host.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const started = await command(bridge.url, '--token', 'private-background-token', '--socket', socketPath, '--background')
  assert.equal(started.code, 0, started.output)
  assert.match(started.output, /You can close this terminal/)
  await waitFor(() => hub.sole())
  const state = readFileSync(join(directory, 'background.json'), 'utf8')
  assert.doesNotMatch(state + started.output, /private-background-token/)
  assert.equal(JSON.parse(state).starting, undefined)
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    assert.equal(statSync(join(directory, 'background.json')).mode & 0o777, 0o600)
    assert.equal(statSync(join(directory, 'relay.log')).mode & 0o777, 0o600)
  } else {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
      Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class RelayConsoleProbe {
        [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId);
        [DllImport("kernel32.dll")] public static extern bool FreeConsole();
      }'
      [void][RelayConsoleProbe]::FreeConsole()
      if ([RelayConsoleProbe]::AttachConsole(${JSON.parse(state).pid})) {
        [void][RelayConsoleProbe]::FreeConsole(); exit 1
      }
      if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 6) { exit 2 }
    `], { encoding: 'utf8', windowsHide: true })
    assert.equal(probe.status, 0, `Background relay has a console or could not be inspected: ${probe.stdout}${probe.stderr}`)
  }
  const status = await command('--status')
  assert.equal(status.code, 0, status.output)
  assert.match(status.output, /background relay running.*linked/)
  const framedStatus = await new Promise((done, fail) => {
    const socket = net.createConnection(JSON.parse(state).endpoint)
    let response = ''
    socket.setTimeout(1_000, () => socket.destroy(new Error('Control reply requires a pipe half-close')))
    socket.on('error', fail)
    socket.on('connect', () => {
      socket.write('{"command":"status",')
      setImmediate(() => socket.write(`${JSON.stringify({ secret: JSON.parse(state).secret }).slice(1)}\n`))
    })
    socket.on('data', (chunk) => { response += chunk })
    socket.on('end', () => done(JSON.parse(response)))
  })
  assert.equal(framedStatus.pid, JSON.parse(state).pid)
  assert.equal(framedStatus.linked, true)
  const duplicate = await command(bridge.url, '--token', 'private-background-token', '--background')
  assert.equal(duplicate.code, 1)
  assert.match(duplicate.output, /already running/)
  const unauthorized = await new Promise((done, fail) => {
    const socket = net.createConnection(JSON.parse(state).endpoint)
    let response = ''
    socket.on('error', fail)
    socket.on('connect', () => socket.end(JSON.stringify({ command: 'stop', secret: 'wrong' })))
    socket.on('data', (chunk) => { response += chunk })
    socket.on('end', () => done(response))
  })
  assert.equal(unauthorized, '')
  assert.ok(hub.sole())
  const link = new ChromeLink(() => hub.sole().open())
  const reply = await link.call('tabs_context_mcp', {})
  assert.equal(reply.result.content[0].text, 'ran tabs_context_mcp')
  link.reset()
  const stopped = await command('--stop')
  assert.equal(stopped.code, 0, stopped.output)
  await waitFor(() => !hub.sole() && !existsSync(join(directory, 'background.json')))
  const offline = await command('--status')
  assert.equal(offline.code, 1)
  assert.match(offline.output, /not running/)
  writeFileSync(join(directory, 'background.json'), state)
  writeFileSync(join(directory, 'relay.log'), Buffer.alloc(5 * 1024 * 1024 + 1))
  const restarted = await command(bridge.url, '--token', 'private-background-token', '--socket', socketPath, '--background')
  assert.equal(restarted.code, 0, restarted.output)
  await waitFor(() => hub.sole())
  assert.ok(existsSync(join(directory, 'relay.log.previous')))
  assert.ok(statSync(join(directory, 'relay.log')).size < 5 * 1024 * 1024)
  await command('--stop')
  await waitFor(() => !hub.sole() && !existsSync(join(directory, 'background.json')))
  const concurrent = await Promise.all([
    command(bridge.url, '--token', 'private-background-token', '--socket', socketPath, '--background'),
    command(bridge.url, '--token', 'private-background-token', '--socket', socketPath, '--background'),
  ])
  assert.deepEqual(concurrent.map((result) => result.code).sort(), [0, 1], JSON.stringify(concurrent))
  await waitFor(() => hub.sole())
})

test('background relay uses explicit hidden Windows spawn and keeps its token off child arguments', () => {
  const source = readFileSync('public/jarvis-relay.mjs', 'utf8')
  assert.match(source, /detached: true, windowsHide: true/)
  assert.match(source, /stdio: \['ignore', log, log, 'ipc'\]/)
  assert.match(source, /spawn\(process\.execPath, \[fileURLToPath\(import\.meta\.url\), '--background-worker', '--background-dir', backgroundDirectory\]/)
  assert.match(source, /JARVIS_RELAY_TOKEN: token/)
})

test('a missing extension on the far machine is reported, not hung on', async (t) => {
  const hub = createRelayHub({ token: 'secret', log: () => {} })
  const bridge = await bridgeWith(hub)
  const relay = spawn(
    process.execPath,
    ['public/jarvis-relay.mjs', bridge.url, '--token', 'secret', '--socket', '/nonexistent/host.sock'],
    { stdio: 'ignore' },
  )
  t.after(() => {
    relay.kill()
    for (const client of bridge.wss.clients) client.terminate()
    bridge.server.close()
  })

  await waitFor(() => hub.sole())
  const link = new ChromeLink(() => hub.sole().open())
  await assert.rejects(link.call('navigate', {}), /extension is not running/)
})

test('forwarded addresses are only believed from loopback', () => {
  const req = (peer, forwarded) => ({
    socket: { remoteAddress: peer },
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  })
  assert.equal(clientAddress(req('::ffff:127.0.0.1', '11.0.0.134')), '11.0.0.134')
  assert.equal(clientAddress(req('11.0.0.50', '11.0.0.134')), '11.0.0.50')
  assert.equal(clientAddress(req('127.0.0.1')), '127.0.0.1')
})
