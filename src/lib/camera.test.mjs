import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createLogger } from 'vite'

async function withCamera(check, play = async () => {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'jarvis-camera-test-'))
  const originals = new Map(['navigator', 'document']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const requests = []
  const videos = []
  let server
  try {
    server = await createServer({
      root: fileURLToPath(new URL('../../', import.meta.url)),
      cacheDir,
      envFile: false,
      customLogger: createLogger('silent'),
      server: { watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
        },
      },
    })
    globalThis.document = {
      createElement: () => {
        const video = { srcObject: null, play, pause() {} }
        videos.push(video)
        return video
      },
    }
    const camera = await server.ssrLoadModule('/src/lib/camera.ts')
    const streams = []
    const open = (index) => {
      const track = { stops: 0, stop() { this.stops++ } }
      const stream = { getTracks: () => [track] }
      streams.push(track)
      requests[index].resolve(stream)
      return track
    }
    await check({ camera, requests, videos, streams, open })
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    await server?.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
}

test('concurrent camera holders share one stream and stop it after the last release', async () => {
  await withCamera(async ({ camera, requests, open }) => {
    const first = camera.holdCamera()
    const second = camera.holdCamera()
    assert.equal(requests.length, 1)
    const track = open(0)
    assert.equal(await first, await second)
    assert.equal(camera.diag.holders, 2)
    camera.releaseCamera()
    assert.equal(track.stops, 0)
    camera.releaseCamera()
    assert.equal(track.stops, 1)
    assert.equal(camera.cameraStream(), null)
    assert.equal(camera.diag.open, false)
  })
})

test('failed camera playback stops acquired tracks and permits a retry', async () => {
  let fail = true
  await withCamera(async ({ camera, open, videos }) => {
    const pending = camera.holdCamera()
    const rejected = assert.rejects(pending, /playback failed/)
    const track = open(0)
    await rejected
    assert.equal(track.stops, 1)
    assert.equal(videos[0].srcObject, null)
    assert.equal(camera.cameraStream(), null)
    assert.equal(camera.diag.holders, 0)
    fail = false
    const retry = camera.holdCamera()
    const retriedTrack = open(1)
    await retry
    camera.releaseCamera()
    assert.equal(retriedTrack.stops, 1)
  }, async () => {
    if (fail) throw new Error('playback failed')
  })
})