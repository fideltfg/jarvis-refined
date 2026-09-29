/**
 * Neural speech, entirely in the browser.
 *
 * `speechSynthesis` is limited to whatever voices the operating system ships,
 * and on macOS the British male option is Daniel — a compact concatenative
 * voice from over a decade ago. It is the honest ceiling of the built-in API
 * and it sounds like a satnav.
 *
 * Kokoro is an 82M-parameter TTS model that runs on WebGPU via ONNX. No cloud,
 * no API key, nothing leaves the machine — but it sounds like a person. It
 * carries a broad voice catalog, so each theme can have its own identity.
 *
 * The cost is a one-time ~330MB model download, cached by the browser
 * afterwards. It's fetched during the boot sequence so the first "Hey Jarvis"
 * isn't waiting on it, and anything that goes wrong falls back to Daniel.
 */

import { KOKORO_VOICE, THEME, type Theme } from '../config'
import ortJsepModuleUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url'
import ortJsepWasmUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url'

type Kokoro = {
  generate: (
    text: string,
    opts: { voice: string; speed?: number },
  ) => Promise<{ toBlob: () => Blob }>
}

let model: Kokoro | null = null
let loading: Promise<Kokoro | null> | null = null
let failed = false

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

export type VoiceProfile = {
  label: string
  voice: string
  speed: number
  playbackRate: number
  highpassHz: number
  lowpassHz: number
  presenceHz: number
  presenceDb: number
  compression: { threshold: number; ratio: number; attack: number; release: number }
}

const PROFILES: Record<Theme, Omit<VoiceProfile, 'voice'>> = {
  stark: {
    label: 'George · clean service voice',
    speed: 0.97,
    playbackRate: 1,
    highpassHz: 70,
    lowpassHz: 11_000,
    presenceHz: 2600,
    presenceDb: 2,
    compression: { threshold: -24, ratio: 3, attack: 0.012, release: 0.18 },
  },
  hal: {
    label: 'Michael · logic core',
    speed: 0.86,
    playbackRate: 0.96,
    highpassHz: 65,
    lowpassHz: 5200,
    presenceHz: 1100,
    presenceDb: -1.5,
    compression: { threshold: -30, ratio: 6, attack: 0.025, release: 0.35 },
  },
  wopr: {
    label: 'Fenrir · command terminal',
    speed: 0.94,
    playbackRate: 1.01,
    highpassHz: 180,
    lowpassHz: 3600,
    presenceHz: 900,
    presenceDb: 4.5,
    compression: { threshold: -28, ratio: 5, attack: 0.008, release: 0.12 },
  },
  mother: {
    label: 'Nicole · ship mainframe',
    speed: 0.88,
    playbackRate: 0.95,
    highpassHz: 85,
    lowpassHz: 4600,
    presenceHz: 700,
    presenceDb: 2.5,
    compression: { threshold: -32, ratio: 7, attack: 0.02, release: 0.4 },
  },
  lcars: {
    // The starship computer: even, unhurried and exact. The band is wider
    // than WOPR's radio, so it reads as a clean shipboard intercom rather
    // than a phone line; the presence lift at 3 kHz gives the consonants
    // their precise, slightly synthetic edge.
    label: 'Nova · starship computer',
    speed: 0.92,
    playbackRate: 1.02,
    highpassHz: 220,
    lowpassHz: 7200,
    presenceHz: 3000,
    presenceDb: 3.5,
    compression: { threshold: -26, ratio: 4, attack: 0.005, release: 0.15 },
  },
}

export const profile: VoiceProfile = { ...PROFILES[THEME], voice }

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
      const { KokoroTTS, env: kokoroEnv } = await import('kokoro-js')
      kokoroEnv.wasmPaths = {
        mjs: ortJsepModuleUrl,
        wasm: ortJsepWasmUrl,
      }
      const tts = await KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-v1.0-ONNX',
        {
          // fp32 is larger than q8, but maps cleanly to WebGPU. Quantised ops
          // can fall back to CPU and become slower than real-time speech.
          dtype: 'fp32',
          device: 'webgpu',
          // The callback is a union across several event shapes; only the
          // download-progress one carries a percentage.
          progress_callback: (p: unknown) => {
            const pct = (p as { progress?: number })?.progress
            if (typeof pct === 'number') progress = pct / 100
          },
        },
      )
      progress = 1
      model = tts as unknown as Kokoro
      return model
    } catch (err) {
      console.warn('[jarvis] kokoro unavailable, using the system voice:', err)
      lastError = String((err as Error)?.message ?? err)
      failed = true
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
      console.warn(
        `[jarvis] kokoro failed ${failures} times running — the system voice from here on.`,
      )
    }
    return null
  }
}

/** Voice ids this build of the model actually carries. */
export async function availableVoices(): Promise<string[]> {
  const tts = (await load()) as unknown as { voices?: Record<string, unknown> } | null
  return tts?.voices ? Object.keys(tts.voices) : []
}
