import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createLogger } from 'vite'

async function withKokoro(run, module = 'kokoro.ts', mocks = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'jarvis-kokoro-test-'))
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  const workers = []
  class FakeWorker {
    messages = []
    terminated = false
    constructor(url, options) {
      assert.ok(url.pathname.endsWith('/kokoro.worker.ts'))
      assert.equal(options.type, 'module')
      workers.push(this)
    }
    postMessage(message) { this.messages.push(message) }
    terminate() { this.terminated = true }
    reply(data) { this.onmessage({ data }) }
  }
  globalThis.Worker = FakeWorker
  let server
  try {
    server = await createServer({
      root: fileURLToPath(new URL('../../', import.meta.url)),
      cacheDir, envFile: false, customLogger: createLogger('silent'),
      server: { watch: null },
      ssr: { noExternal: ['kokoro-js', '@huggingface/transformers'] },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [{
        name: 'kokoro-test-dependencies', enforce: 'pre',
        resolveId(source, importer) {
          if (importer?.endsWith(`/src/lib/${module}`) && source in mocks) return `\0kokoro-mock:${source}`
          if (importer?.endsWith('/src/lib/kokoro.ts') && ['../config', './theme-runtime'].includes(source)) {
            return `\0kokoro-test:${source}`
          }
        },
        load(id) {
          if (id.startsWith('\0kokoro-mock:')) return mocks[id.slice('\0kokoro-mock:'.length)]
          if (id === '\0kokoro-test:../config') return 'export const KOKORO_VOICE = "bm_george"'
          if (id === '\0kokoro-test:./theme-runtime') return 'export const activeTheme = () => ({voice: {profile: {speed: 1}}})'
        },
      }],
    })
    const kokoro = await server.ssrLoadModule(`/src/lib/${module}`)
    await run(kokoro, workers)
  } finally {
    await server?.close()
    if (original) Object.defineProperty(globalThis, 'Worker', original)
    else delete globalThis.Worker
    await rm(cacheDir, { recursive: true, force: true })
  }
}

test('Kokoro loads once in a worker and routes concurrent speech by request ID', async () => {
  await withKokoro(async (kokoro, workers) => {
    const firstLoad = kokoro.load()
    const secondLoad = kokoro.load()
    assert.equal(workers.length, 1)
    const worker = workers[0]
    assert.equal(worker.messages.length, 1)
    worker.reply({ type: 'progress', progress: 0.5 })
    assert.equal(kokoro.loadProgress(), 0.5)
    worker.reply({ type: 'ready', id: worker.messages[0].id, voices: ['bm_george'] })
    assert.equal(await firstLoad, await secondLoad)
    assert.equal(kokoro.isReady(), true)
    assert.equal(kokoro.loadProgress(), 1)
    assert.deepEqual(await kokoro.availableVoices(), ['bm_george'])
    const first = kokoro.speak('First sentence')
    const second = kokoro.speak('Second sentence')
    await Promise.resolve()
    const requests = worker.messages.slice(1)
    assert.deepEqual(requests.map(({ text, voice, speed }) => ({ text, voice, speed })), [
      { text: 'First sentence', voice: 'bm_george', speed: 1 },
      { text: 'Second sentence', voice: 'bm_george', speed: 1 },
    ])
    worker.reply({ type: 'audio', id: requests[1].id, audio: new Blob(['second']) })
    worker.reply({ type: 'audio', id: requests[0].id, audio: new Blob(['first']) })
    const firstUrl = await first
    const secondUrl = await second
    try {
      assert.equal(await (await fetch(firstUrl)).text(), 'first')
      assert.equal(await (await fetch(secondUrl)).text(), 'second')
    } finally {
      URL.revokeObjectURL(firstUrl)
      URL.revokeObjectURL(secondUrl)
    }
  })
})

test('a worker crash settles pending speech and permanently enables fallback', async () => {
  await withKokoro(async (kokoro, workers) => {
    const loading = kokoro.load()
    const worker = workers[0]
    worker.reply({ type: 'ready', id: worker.messages[0].id, voices: [] })
    await loading
    const speech = kokoro.speak('Hello')
    await Promise.resolve()
    worker.onerror({ message: 'GPU device lost' })
    assert.equal(await speech, null)
    assert.equal(kokoro.isUnavailable(), true)
    assert.equal(kokoro.isReady(), false)
    assert.equal(kokoro.lastError, 'GPU device lost')
    assert.equal(worker.terminated, true)
    assert.equal(await kokoro.speak('Retry'), null)
    assert.equal(workers.length, 1)
  })
})

test('the inference worker serializes generation and continues after a sentence fails', async () => {
  const keys = ['onmessage', 'postMessage', '__kokoroWorkerTest']
  const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const responses = []
  const generations = []
  const state = {
    loads: 0,
    env: {},
    transformersEnv: { backends: { onnx: { wasm: {} } } },
    model: {
      voices: { bm_george: true },
      generate(text, options) {
        return new Promise((resolve, reject) => generations.push({ text, options, resolve, reject }))
      },
    },
  }
  const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.fail('Worker did not respond')
  }
  globalThis.__kokoroWorkerTest = state
  globalThis.postMessage = (response) => responses.push(response)
  try {
    await withKokoro(async () => {
      globalThis.onmessage({ data: { type: 'load', id: 1 } })
      await waitFor(() => responses.some(({ type }) => type === 'ready'))
      assert.equal(state.loads, 1)
      assert.equal(state.options.device, 'wasm')
      assert.equal(state.options.dtype, 'q8')
      assert.equal(state.transformersEnv.backends.onnx.wasm.numThreads, 1)
      assert.ok(state.env.wasmPaths.mjs.endsWith('.mjs'))
      assert.ok(state.env.wasmPaths.wasm.endsWith('.wasm'))
      assert.deepEqual(responses, [
        { type: 'progress', progress: 0.5 },
        { type: 'ready', id: 1, voices: ['bm_george'] },
      ])
      globalThis.onmessage({ data: { type: 'generate', id: 2, text: 'First', voice: 'bm_george', speed: 0.9 } })
      globalThis.onmessage({ data: { type: 'generate', id: 3, text: 'Second', voice: 'bm_george', speed: 1 } })
      await waitFor(() => generations.length === 1)
      assert.deepEqual(generations[0].options, { voice: 'bm_george', speed: 0.9 })
      generations[0].reject(new Error('Sentence failed'))
      await waitFor(() => generations.length === 2)
      assert.deepEqual(responses.at(-1), { type: 'error', id: 2, error: 'Sentence failed' })
      generations[1].resolve({ toBlob: () => new Blob(['speech']) })
      await waitFor(() => responses.at(-1).type === 'audio')
      assert.equal(responses.at(-1).id, 3)
      assert.equal(await responses.at(-1).audio.text(), 'speech')
      assert.equal(state.loads, 1)
    }, 'kokoro.worker.ts', {
      '@huggingface/transformers': 'export const env = globalThis.__kokoroWorkerTest.transformersEnv',
      'kokoro-js': `export const env = globalThis.__kokoroWorkerTest.env;
        export const KokoroTTS = { from_pretrained: async (name, options) => {
          const state = globalThis.__kokoroWorkerTest;
          state.loads++; state.options = options;
          options.progress_callback({progress: 50});
          return state.model;
        }};`,
    })
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})