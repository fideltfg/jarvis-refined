import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createFrontendServer } from './serve.mjs'

/** Start a temporary frontend and bridge pair, then register their cleanup. */
async function fixture(context, upstreamHandler) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-serve-'))
  writeFileSync(join(directory, 'index.html'), '<html>JARVIS</html>')
  writeFileSync(join(directory, 'runtime.wasm'), 'wasm')
  writeFileSync(join(directory, '.env'), 'secret')
  const upstream = http.createServer(upstreamHandler)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const server = await createFrontendServer({ directory, bridgePort: upstream.address().port })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  // Release both listeners and remove the temporary frontend files after each test.
  context.after(() => {
    server.closeAllConnections()
    server.close()
    upstream.closeAllConnections()
    upstream.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, server, upstream, url: `http://127.0.0.1:${server.address().port}` }
}

// Checks static content types, range handling, hidden paths, and unsupported methods.
test('production frontend serves HTML, WASM and HEAD without exposing hidden files', async (context) => {
  const { url } = await fixture(context)
  assert.match(await (await fetch(url)).text(), /JARVIS/)
  const wasm = await fetch(`${url}/runtime.wasm`)
  assert.equal(wasm.headers.get('content-type'), 'application/wasm')
  const head = await fetch(`${url}/runtime.wasm`, { method: 'HEAD' })
  assert.equal(head.headers.get('content-length'), '4')
  assert.equal(await head.text(), '')
  const partial = await fetch(`${url}/runtime.wasm`, { headers: { range: 'bytes=1-2' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), 'bytes 1-2/4')
  assert.equal(await partial.text(), 'as')
  assert.equal(await (await fetch(`${url}/runtime.wasm`, { headers: { range: 'bytes=-2' } })).text(), 'sm')
  assert.equal((await fetch(`${url}/runtime.wasm`, { headers: { range: 'bytes=8-9' } })).status, 416)
  assert.equal((await fetch(`${url}/.env`)).status, 403)
  assert.equal((await fetch(`${url}/absent.js`)).status, 404)
  assert.equal((await fetch(url, { method: 'POST' })).status, 405)
})

// Confirms canonical-path checks reject traversal and links that escape the release root.
test('frontend rejects encoded traversal and symlinks outside the release', async (context) => {
  const { directory, server, url } = await fixture(context)
  const outside = mkdtempSync(join(tmpdir(), 'jarvis-outside-'))
  writeFileSync(join(outside, 'secret'), 'private')
  symlinkSync(join(outside, 'secret'), join(directory, 'escape'))
  context.after(() => rmSync(outside, { recursive: true, force: true }))
  assert.equal((await fetch(`${url}/escape`)).status, 403)
  const status = await new Promise((done) => {
    // Use the raw HTTP client to preserve the encoded traversal path.
    http.get({ hostname: '127.0.0.1', port: server.address().port,
      path: '/%2e%2e/secret' }, (response) => {
        // Drain the response so the request socket can close cleanly.
        response.resume()
        done(response.statusCode)
      })
  })
  assert.equal(status, 403)
})

// Verifies proxy path rewriting and replacement of caller-supplied forwarding headers.
test('bridge proxy strips only its prefix and replaces spoofed forwarding headers', async (context) => {
  const { url } = await fixture(context, (request, response) => {
    // Echo the forwarded request so the test can inspect the bridge contract.
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ url: request.url, headers: request.headers }))
  })
  const response = await fetch(`${url}/bridge/health?probe=1`, {
    headers: { origin: 'http://untrusted.example', 'x-forwarded-for': 'spoofed',
      forwarded: 'for=spoofed', 'x-forwarded-proto': 'https' },
  })
  const body = await response.json()
  assert.equal(body.url, '/health?probe=1')
  assert.equal(body.headers.origin, 'http://untrusted.example')
  assert.equal(body.headers['x-forwarded-for'], '127.0.0.1')
  assert.equal(body.headers['x-forwarded-proto'], 'http')
  assert.equal(body.headers.forwarded, undefined)
  assert.equal((await fetch(`${url}/bridge-not-a-route`)).status, 404)
  const rebinding = await new Promise((done) => {
    // Bypass fetch's Host handling to verify rejection of a rebinding header.
    http.get(`${url}/bridge/health`, { headers: { host: 'evil.example' } }, (response) => {
      response.resume()
      done(response.statusCode)
    })
  })
  assert.equal(rebinding, 403)
})

// Checks bidirectional WebSocket forwarding and preserves the bridge's origin gate.
test('WebSocket proxy carries messages and does not bypass upstream origin rejection', async (context) => {
  const { url, upstream } = await fixture(context)
  const sockets = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (request, socket, head) => {
    if (request.headers.origin !== 'http://allowed.example') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    assert.equal(request.url, '/')
    sockets.handleUpgrade(request, socket, head, (client) => {
      // Echo frames so the test can prove that the tunnel is bidirectional.
      client.on('message', (data) => client.send(data))
    })
  })
  // Terminate test sockets before closing the WebSocket server.
  context.after(() => { for (const client of sockets.clients) client.terminate(); sockets.close() })
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/bridge', { origin: 'http://allowed.example' })
  // Ensure a failed assertion cannot leave the client socket open.
  context.after(() => socket.terminate())
  await once(socket, 'open')
  const message = once(socket, 'message')
  socket.send('ping')
  assert.equal((await message)[0].toString(), 'ping')
  const rejected = new WebSocket(url.replace('http:', 'ws:') + '/bridge', { origin: 'http://untrusted.example' })
  const [error] = await once(rejected, 'error')
  assert.match(error.message, /403/)
})