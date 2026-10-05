import http from 'node:http'
import https from 'node:https'
import { createReadStream, readFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
}

function bridgePath(url = '/') {
  if (!/^\/bridge(?:\/|\?|$)/.test(url)) return null
  const stripped = url.slice('/bridge'.length)
  return !stripped || stripped.startsWith('?') ? `/${stripped}` : stripped
}

function proxyHeaders(request, port) {
  const headers = { ...request.headers, host: `127.0.0.1:${port}` }
  for (const name of Object.keys(headers)) {
    if (name.startsWith('x-forwarded-') || name === 'forwarded') delete headers[name]
  }
  headers['x-forwarded-for'] = request.socket.remoteAddress
  headers['x-forwarded-host'] = request.headers.host
  headers['x-forwarded-proto'] = request.socket.encrypted ? 'https' : 'http'
  return headers
}

export async function createFrontendServer({ directory, bridgePort = 8787, tls,
  allowedHosts = ['localhost', '127.0.0.1', '[::1]'] } = {}) {
  const root = await realpath(directory ?? resolve('dist'))
  const index = await stat(resolve(root, 'index.html'))
  if (!index.isFile()) throw new Error('Build the frontend before starting the production runtime.')
  const upstreamSockets = new Set()
  const trustedHosts = new Set(allowedHosts.map((host) => host.toLowerCase()))
  function trustedHost(request) {
    const host = request.headers.host
    if (!host || /[@/\\\s?#]/.test(host)) return false
    try { return trustedHosts.has(new URL(`http://${host}`).hostname) } catch { return false }
  }
  const handler = async (request, response) => {
    if (!trustedHost(request)) {
      response.writeHead(403).end()
      return
    }
    const path = bridgePath(request.url)
    if (path !== null) {
      const proxy = http.request({ hostname: '127.0.0.1', port: bridgePort,
        path, method: request.method, headers: proxyHeaders(request, bridgePort) }, (upstream) => {
        response.writeHead(upstream.statusCode, upstream.headers)
        upstream.pipe(response)
      })
      proxy.on('error', () => {
        if (!response.headersSent) response.writeHead(502)
        response.end('Bridge unavailable')
      })
      response.on('close', () => proxy.destroy())
      request.pipe(proxy)
      return
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    try {
      const pathname = decodeURIComponent(request.url.split('?')[0])
      if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\') ||
          pathname.split('/').some((part) => part === '..' || part.startsWith('.'))) {
        response.writeHead(403).end()
        return
      }
      const target = await realpath(resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`))
      const rel = relative(root, target)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        response.writeHead(403).end()
        return
      }
      const info = await stat(target)
      if (!info.isFile()) {
        response.writeHead(404).end()
        return
      }
      let start = 0
      let end = info.size - 1
      const range = request.headers.range
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (match && (match[1] || match[2])) {
          start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]))
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
        }
        if (!match || (!match[1] && !match[2]) || start > end || start >= info.size || end < 0) {
          response.writeHead(416, { 'content-range': `bytes */${info.size}` }).end()
          return
        }
      }
      response.writeHead(range ? 206 : 200, {
        'content-type': types[extname(target)] ?? 'application/octet-stream',
        'content-length': range ? end - start + 1 : info.size, 'cache-control': 'no-cache',
        'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}),
        'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
      })
      if (request.method === 'HEAD') response.end()
      else createReadStream(target, range ? { start, end } : undefined).on('error', () => response.destroy()).pipe(response)
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 400).end()
    }
  }
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler)
  server.on('upgrade', (request, socket, head) => {
    if (!trustedHost(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const path = bridgePath(request.url)
    if (path === null) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const proxy = http.request({ hostname: '127.0.0.1', port: bridgePort,
      path, headers: proxyHeaders(request, bridgePort) })
    proxy.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
      upstreamSockets.add(upstreamSocket)
      upstreamSocket.on('close', () => upstreamSockets.delete(upstreamSocket))
      const headers = upstream.rawHeaders.reduce((text, value, position) =>
        text + (position % 2 === 0 ? `${value}: ` : `${value}\r\n`), '')
      socket.write(`HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage}\r\n${headers}\r\n`)
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) upstreamSocket.write(head)
      socket.pipe(upstreamSocket).pipe(socket)
      socket.on('error', () => upstreamSocket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.on('error', () => socket.destroy())
      upstreamSocket.on('close', () => socket.destroy())
    })
    proxy.on('response', (upstream) => {
      socket.end(`HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage}\r\nConnection: close\r\n\r\n`)
      upstream.resume()
    })
    proxy.on('error', () => socket.destroy())
    socket.on('close', () => proxy.destroy())
    proxy.end()
  })
  server.on('close', () => {
    for (const socket of upstreamSockets) socket.destroy()
  })
  return server
}

function port(value, fallback) {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('Invalid service port')
  return number
}

export async function startProduction() {
  const facePort = port(process.env.PORT, 5173)
  const bridgePort = port(process.env.JARVIS_BRIDGE_PORT, 8787)
  const host = process.env.JARVIS_HOST || '127.0.0.1'
  const cert = process.env.JARVIS_TLS_CERT
  const key = process.env.JARVIS_TLS_KEY
  if (Boolean(cert) !== Boolean(key)) throw new Error('Set both JARVIS_TLS_CERT and JARVIS_TLS_KEY')
  if (!cert && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Non-loopback frontend binding requires HTTPS')
  }
  const allowedHosts = ['localhost', '127.0.0.1', '[::1]', host]
  for (const origin of (process.env.JARVIS_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)) {
    allowedHosts.push(new URL(origin).hostname)
  }
  const server = await createFrontendServer({ bridgePort, allowedHosts,
    tls: cert ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined })
  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(facePort, host, done)
  })
  const scheme = cert ? 'https' : 'http'
  const origins = `${scheme}://localhost:${facePort},${scheme}://127.0.0.1:${facePort}`
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    stdio: 'inherit', env: { ...process.env,
      JARVIS_ALLOWED_ORIGINS: process.env.JARVIS_ALLOWED_ORIGINS || origins,
      JARVIS_ALLOW_WRITES: process.argv.includes('--writes') ? '1' : '0' },
  })
  let stopping = false
  function stop(code) {
    if (stopping) return
    stopping = true
    child.kill('SIGTERM')
    server.close()
    server.closeAllConnections()
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      process.exit(code)
    }, 5_000)
    timer.unref()
    process.exitCode = code
  }
  child.once('error', (error) => { console.error(error.message); stop(1) })
  child.once('exit', (code) => stop(stopping ? process.exitCode : (code ?? 1)))
  server.on('error', (error) => { console.error(error.message); stop(1) })
  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))
  console.log(`JARVIS production interface: ${scheme}://localhost:${facePort}`)
  return { server, child }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startProduction().catch((error) => { console.error(error.message); process.exitCode = 1 })
}