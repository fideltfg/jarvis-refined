import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createLogger } from 'vite'

test('development timing cleanup periodically releases measures and disposes its timer', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'jarvis-performance-test-'))
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const timers = new Map()
  const measures = []
  let server
  try {
    globalThis.window = {
      performance: { clearMeasures: () => { measures.length = 0 } },
      setInterval: (callback, delay) => {
        assert.equal(delay, 5000)
        timers.set(1, callback)
        return 1
      },
      clearInterval: (timer) => timers.delete(timer),
    }
    server = await createServer({
      root: fileURLToPath(new URL('../../', import.meta.url)),
      cacheDir,
      envFile: false,
      customLogger: createLogger('silent'),
      server: { watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
    const { startPerformanceCleanup } = await server.ssrLoadModule('/src/lib/performance.ts')
    const stop = startPerformanceCleanup()
    assert.equal(timers.size, 1)
    for (let cycle = 0; cycle < 3; cycle++) {
      measures.push('Update', 'component render')
      timers.get(1)()
      assert.equal(measures.length, 0)
    }
    stop()
    assert.equal(timers.size, 0)
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete globalThis.window
    await server?.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test('timing cleanup runs only in development and is disposed during hot reload', async () => {
  const source = await readFile(new URL('../main.tsx', import.meta.url), 'utf8')
  assert.match(source, /if \(import\.meta\.env\.DEV\) \{\s*const stopPerformanceCleanup = startPerformanceCleanup\(\)\s*import\.meta\.hot\?\.dispose\(stopPerformanceCleanup\)/)
})

test('LCARS batches microphone levels into its bounded chart cadence', async () => {
  const source = await readFile(new URL('../../public/themes/lcars/Reactor.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /useStore\(\(state\) => state\.level\)/)
  assert.match(source, /const SAMPLE_MS = 50\b/)
  assert.match(source, /const nextLevel = useStore\.getState\(\)\.level\s*setLevel\(nextLevel\)\s*setTrace\(\(samples\) => \[\.\.\.samples\.slice\(1\), nextLevel\]\)\s*\}, SAMPLE_MS\)/)
  assert.match(source, /return \(\) => window\.clearInterval\(id\)/)
})

test('LCARS chart ticks re-render only the signal panel, not the whole console', async () => {
  const source = await readFile(new URL('../../public/themes/lcars/Reactor.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('export function Reactor(')
  const end = source.indexOf('\n}\n', start)
  const console = source.slice(start, end)
  assert.doesNotMatch(console, /setTrace|setLevel/)
  assert.match(console, /<SignalPanel phase=\{phase\} \/>/)
})