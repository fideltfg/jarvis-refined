import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createLogger } from 'vite'

test('microphone mute applies before acquisition and toggles every shared audio track', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const tracks = [{ enabled: true }, { enabled: true }]
  const stream = { getAudioTracks: () => tracks }
  let resolveMic
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { resolveMic = resolve }) } },
  })
  try {
    const audio = await import('./audio.ts')
    const pending = audio.getMic()
    audio.setMicMuted(true)
    resolveMic(stream)
    assert.equal(await pending, stream)
    assert.ok(tracks.every((track) => !track.enabled))
    assert.equal(audio.micLevel(), 0)
    audio.setMicMuted(false)
    assert.ok(tracks.every((track) => track.enabled))
    assert.equal(await audio.getMic(), stream)
    audio.setMicMuted(true)
    assert.ok(tracks.every((track) => !track.enabled))
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
  }
})

for (const serverVoice of [true, false]) {
  test(`${serverVoice ? 'server' : 'browser'} voice mutes only Jarvis between push-to-talk presses`, async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'jarvis-audio-test-'))
    const originals = new Map(['navigator', 'window', '__voiceTest']
      .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
    const track = { enabled: true }
    const otherAppTrack = { enabled: true }
    const captureStates = []
    const state = { serverVoice, track, captureStates }
    const mocks = {
      '../config': 'export const BRIDGE_HTTP_URL = "http://unused"',
      './tts': 'export const speakingNow = () => ""; export const speakingSince = () => 0',
      './echo': 'export const OVERRIDE = /stop/; export const cutsThrough = () => false; export const isEcho = () => false',
      './capabilities': 'export const caps = () => ({ stt: globalThis.__voiceTest.serverVoice })',
      './speaker': 'export const getProfile = () => null; export const verify = () => ({ok: true}); export const warmSpeaker = () => {}; export const diag = {}',
      './owner': 'export const startOwnerGate = async () => null',
      '../theme': 'export const NAME_PATTERN = "jarvis"; export const SPEECH_LANGUAGE = "en-US"; export const WAKE_PHRASES = ["jarvis"]',
      './vad': `export const startVad = async () => ({
        live: () => true, stop: () => {}, setGuard: () => {}, setManual: () => {},
        hold: (down) => globalThis.__voiceTest.captureStates.push({ down, enabled: globalThis.__voiceTest.track.enabled }),
        meter: () => ({ speaking: false }),
      })`,
    }
    let server
    let voice
    try {
      globalThis.__voiceTest = state
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track] }) } },
      })
      globalThis.window = {
        SpeechRecognition: class {
          start() {
            captureStates.push({ down: true, enabled: track.enabled })
            this.onstart?.()
          }
          stop() {
            captureStates.push({ down: false, enabled: track.enabled })
            this.onend?.()
          }
          abort() { this.onend?.() }
        },
      }
      server = await createServer({
        root: fileURLToPath(new URL('../../', import.meta.url)),
        cacheDir,
        envFile: false,
        customLogger: createLogger('silent'),
        server: { watch: null },
        optimizeDeps: { noDiscovery: true, include: [] },
        plugins: [{
          name: 'voice-test-dependencies',
          enforce: 'pre',
          resolveId(source, importer) {
            if (importer?.endsWith('/src/lib/voice.ts') && source in mocks) return `\0voice-test:${source}`
          },
          load(id) {
            if (id.startsWith('\0voice-test:')) return mocks[id.slice('\0voice-test:'.length)]
          },
        }],
      })
      const { startVoice } = await server.ssrLoadModule('/src/lib/voice.ts')
      voice = await startVoice({
        mode: () => 'command',
        onWake() {}, onSpeechStart() {}, onSpeechMaybe() {}, onSpeechResume() {},
        onPartial() {}, onUtterance() {},
        onError(message) { assert.fail(message) },
      }, { pushToTalk: true })
      assert.equal(track.enabled, false)
      voice.hold(true)
      assert.equal(track.enabled, true)
      assert.deepEqual(captureStates.at(-1), { down: true, enabled: true })
      voice.hold(false)
      assert.equal(track.enabled, false)
      assert.deepEqual(captureStates.at(-1), { down: false, enabled: true })
      voice.setPushToTalk(false)
      assert.equal(track.enabled, true)
      voice.hold(false)
      assert.equal(track.enabled, true)
      voice.setPushToTalk(true)
      assert.equal(track.enabled, false)
      voice.hold(true)
      voice.setPushToTalk(true)
      assert.equal(track.enabled, true)
      voice.stop()
      voice.hold(true)
      voice.setPushToTalk(false)
      assert.equal(track.enabled, false)
      assert.equal(otherAppTrack.enabled, true)
    } finally {
      voice?.stop()
      await server?.close()
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
}