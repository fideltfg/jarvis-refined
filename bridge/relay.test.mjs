import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
  const socketPath = join(dir, 'host.sock')
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
