/**
 * Neural speech, entirely in the browser.
 *
 * `speechSynthesis` is limited to whatever voices the operating system ships,
 * and on macOS the British male option is Daniel — a compact concatenative
 * voice from over a decade ago. It is the honest ceiling of the built-in API
 * and it sounds like a satnav.
 *
 * Kokoro is an 82M-parameter TTS model that runs in a CPU worker via ONNX. No cloud,
 * no API key, nothing leaves the machine — but it sounds like a person. It
 * carries a broad voice catalog, so each theme can have its own identity.
 *
 * The cost is a one-time ~90MB model download, cached by the browser
 * afterwards. It's fetched during the boot sequence so the first "Hey Jarvis"
 * isn't waiting on it, and anything that goes wrong falls back to Daniel.
 */

import { KOKORO_VOICE } from '../config'
import { activeTheme, type VoiceProfileShape } from './theme-runtime'
import type { KokoroRequest, KokoroResponse } from './kokoro.worker'

type Kokoro = {
  voices: Record<string, unknown>
  generate: (
    text: string,
    opts: { voice: string; speed?: number },
  ) => Promise<{ toBlob: () => Blob }>
}

let model: Kokoro | null = null
let loading: Promise<Kokoro | null> | null = null
let failed = false
let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, {
  resolve: (response: KokoroResponse) => void
  reject: (error: Error) => void
}>()

function stopWorker(error: Error) {
  worker?.terminate()
  worker = null
  model = null
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function request(message: Omit<KokoroRequest, 'id'>): Promise<KokoroResponse> {
  if (!worker) {
    worker = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }: MessageEvent<KokoroResponse>) => {
      if (data.type === 'progress') {
        progress = data.progress
        return
      }
      const callback = pending.get(data.id)
      if (!callback) return
      pending.delete(data.id)
      if (data.type === 'error') callback.reject(new Error(data.error))
      else callback.resolve(data)
    }
    worker.onerror = (event) => {
      lastError = event.message || 'Kokoro worker failed'
      failed = true
      stopWorker(new Error(lastError))
    }
    worker.onmessageerror = () => {
      lastError = 'Unable to read Kokoro worker response'
      failed = true
      stopWorker(new Error(lastError))
    }
  }
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      worker!.postMessage({ ...message, id })
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}

/** 0..1 while the model downloads, for the boot readout. */
let progress = 0
export const loadProgress = () => progress
export const isReady = () => model !== null
export const isUnavailable = () => failed

/** Exposed for diagnosis — the console warning alone is easy to miss. */
export let lastError = ''

/**
 * The voices each character may use, in the order they suit it. For JARVIS,
 * British males: George is the closest to a measured RP baritone; Fable is
 * warmer, Lewis lower, Daniel brighter. For the ship's computer, American
 * females: Nicole is the most level, then Sarah, Heart, Bella. Nova is the
 * crispest and most clipped, which is why the starship computer uses it; Kore
 * is the softer alternative.
 */
export const VOICES = [
  'bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel',
  'am_michael', 'am_fenrir', 'am_echo', 'am_onyx',
  'af_nicole', 'af_sarah', 'af_heart', 'af_bella',
  'af_nova', 'af_kore',
] as const

/**
 * A voice id the model doesn't carry throws inside generate(), once per
 * sentence, for the life of the page — and a typo in an env var is the likeliest
 * way to get there. Check it once at module load and fall back audibly in the
 * console instead.
 */
function resolveVoice(): string {
  if ((VOICES as readonly string[]).includes(KOKORO_VOICE)) return KOKORO_VOICE
  console.warn(
    `[jarvis] VITE_KOKORO_VOICE="${KOKORO_VOICE}" is not one of ${VOICES.join(', ')} — using ${VOICES[0]}.`,
  )
  return VOICES[0]
}

const voice = resolveVoice()

/**
 * How the voice is shaped after generation. The numbers live in the active
 * theme's manifest, so a new character can sound like a phone line or a
 * shipboard intercom without a code change.
 */
export type VoiceProfile = VoiceProfileShape & { voice: string }

export const profile: VoiceProfile = { ...activeTheme().voice.profile, voice }

/**
 * Generation failures latch after this many in a row. One is worth retrying —
 * a WebGPU device can be lost and recovered — but a run of them means the
 * engine is not going to work on this machine, and it is better to drop to the
 * system voice for good than to alternate between the two mid-conversation.
 */
const MAX_FAILURES = 3
let failures = 0

export async function load(): Promise<Kokoro | null> {
  if (model) return model
  if (failed) return null
  if (loading) return loading

  loading = (async () => {
    try {
      const response = await request({ type: 'load' })
      if (response.type !== 'ready') throw new Error('Unexpected Kokoro load response')
      progress = 1
      model = {
        voices: Object.fromEntries(response.voices.map((name) => [name, true])),
        generate: async (text: string, opts: { voice: string; speed?: number }) => {
          const generated = await request({ type: 'generate', text, ...opts })
          if (generated.type !== 'audio') throw new Error('Unexpected Kokoro audio response')
          return { toBlob: () => generated.audio }
        },
      }
      return model
    } catch (err) {
      console.warn('[jarvis] kokoro unavailable, using the system voice:', err)
      lastError = String((err as Error)?.message ?? err)
      failed = true
      stopWorker(new Error(lastError))
      return null
    } finally {
      loading = null
    }
  })()

  return loading
}

/** Synthesise one sentence. Returns null if the model isn't usable. */
export async function speak(text: string): Promise<string | null> {
  const tts = await load()
  if (!tts) return null
  try {
    const audio = await tts.generate(text, {
      voice: profile.voice,
      speed: profile.speed,
    })
    failures = 0
    return URL.createObjectURL(audio.toBlob())
  } catch (err) {
    // Surfaced rather than swallowed: a silent null here just looks like the
    // voice quietly reverting to the system one with no explanation.
    console.error('[jarvis] kokoro generation failed:', err)
    lastError = String((err as Error)?.message ?? err)
    failures++
    if (failures >= MAX_FAILURES) {
      // Nothing else sets this on the generation path, so without it tts.ts
      // keeps routing every sentence here and every sentence keeps throwing.
      failed = true
      stopWorker(new Error(lastError))
      console.warn(
        `[jarvis] kokoro failed ${failures} times running — the system voice from here on.`,
      )
    }
    return null
  }
}

/** Voice ids this build of the model actually carries. */
export async function availableVoices(): Promise<string[]> {
  const tts = await load()
  return tts?.voices ? Object.keys(tts.voices) : []
}
