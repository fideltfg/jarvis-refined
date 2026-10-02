/**
 * Sound design.
 *
 * Every cue is synthesised in Web Audio rather than shipped as a file, so the
 * app makes the right noises the moment you clone it — nothing to download, no
 * licence to worry about, a few hundred bytes instead of a few megabytes.
 *
 * To use real recordings instead, drop matching files into a theme's own
 * `audio/` folder (`public/themes/<id>/audio/`).
 * Numbered variants such as wake-1.mp3 and
 * wake-2.mp3 rotate randomly without an immediate repeat. They take over
 * automatically. Pixabay's sci-fi UI and HUD packs are the usual source —
 * CC0, no attribution, safe on a monetised channel. `ambient.mp3` is not one of
 * these: the looping bed is music.ts's, and the oscillator pair at the bottom of
 * this file is only the fallback for when that file isn't there.
 */

import { activeTheme, activeThemePackage } from './theme-runtime'
import { chooseVariant, fileStem } from './sfx-variants'

type BaseCue = 'boot' | 'wake' | 'listen' | 'tool' | 'done' | 'error'
type ExtraCue = 'interrupt' | 'ack' | 'warning' | 'panelOpen' | 'panelClose' | 'taskStart' | 'taskPause' | 'taskDone' | 'micOpen' | 'micClose'
type Cue = BaseCue | ExtraCue

const CUES: Cue[] = [
  'boot', 'wake', 'listen', 'tool', 'done', 'error', 'interrupt', 'ack', 'warning',
  'panelOpen', 'panelClose', 'taskStart', 'taskPause', 'taskDone', 'micOpen', 'micClose',
]

/**
 * Recordings belong to the active theme; missing cues fall back to synthesis.
 */
const OVERRIDE_DIRS = [`${activeTheme().dir}/audio`]

let ctx: AudioContext | null = null
let master: GainNode | null = null
const samples = new Map<Cue, AudioBuffer[]>()
const previous = new Map<Cue, number>()
let ambient: { source: AudioBufferSourceNode; gain: GainNode } | null = null

/** Where the master sits when JARVIS isn't speaking. */
let volume = 0.5
let ducked = false
/** How far everything this module makes drops under the voice. */
const DUCK = 0.45

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = volume
    master.connect(ctx.destination)
  }
  return ctx
}

/**
 * Ramp a gain to a new value from wherever it actually is.
 *
 * The cancel-then-anchor dance is not optional: a Web Audio ramp interpolates
 * from the *previous scheduled event*, so a later automation point that hasn't
 * fired yet — the three-second fade-in of the bed, say — survives, and the
 * value climbs back to it the moment the new ramp lands. That is how ducking
 * during the first seconds of the bed used to undo itself.
 */
function rampTo(param: AudioParam, to: number, seconds: number) {
  if (!ctx) return
  const now = ctx.currentTime
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(Math.max(0.0001, to), now + seconds)
}

/**
 * Browsers won't start audio until the user has interacted with the page, so
 * this has to be called from a click or keypress.
 */
export async function unlockAudio(): Promise<void> {
  const c = audio()
  if (c.state === 'suspended') {
    try {
      await c.resume()
    } catch {
      /**
       * Swallowed on purpose, now that a clap can start the assistant.
       *
       * resume() rejects when there has been no user gesture, and a clap is not
       * one — the browser has no idea a microphone heard anything. Letting that
       * reject would abort the whole power-up over a sound that may well play
       * fine anyway (any earlier interaction with the page unlocks it). Boot
       * either way: the worst case is a silent start, not a dead one.
       */
    }
  }
  await Promise.race([
    loadOverrides(),
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ])
}

/** Pick up any real audio files the user has dropped into a theme's audio/. */
async function loadOverrides() {
  await Promise.all(
    CUES.map(async (cue) => {
      if (samples.has(cue)) return
      const stem = fileStem(cue)
      for (const dir of OVERRIDE_DIRS) {
        const variants: AudioBuffer[] = []
        for (let index = 0; index <= 16; index++) {
          const name = index ? `${stem}-${index}` : stem
          try {
            const res = await fetch(`${dir}/${name}.mp3`)
            if (!res.ok) {
              if (index) break
              continue
            }
            variants.push(await audio().decodeAudioData(await res.arrayBuffer()))
          } catch {
            if (index) break
          }
        }
        if (variants.length) {
          samples.set(cue, variants)
          return
        }
      }
    }),
  )
}

export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v))
  if (master) rampTo(master.gain, ducked ? volume * DUCK : volume, 0.05)
}

// ---------------------------------------------------------------------------
// Synthesis helpers
// ---------------------------------------------------------------------------

/** A pitched blip with an exponential decay — the basic HUD tick. */
function blip(
  freq: number,
  {
    at = 0,
    dur = 0.12,
    type = 'sine' as OscillatorType,
    gain = 0.25,
    sweepTo = 0,
  } = {},
) {
  const c = audio()
  const t = c.currentTime + at
  const osc = c.createOscillator()
  const env = c.createGain()

  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t + dur)

  // Fast attack, exponential tail — reads as electronic rather than musical.
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(gain, t + 0.008)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)

  osc.connect(env).connect(master!)
  osc.start(t)
  osc.stop(t + dur + 0.02)
}

/** Filtered noise burst — air, whooshes, transients. */
function noise({ at = 0, dur = 0.4, gain = 0.12, from = 400, to = 6000 } = {}) {
  const c = audio()
  const t = c.currentTime + at
  const frames = Math.floor(c.sampleRate * dur)
  const buf = c.createBuffer(1, frames, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1

  const src = c.createBufferSource()
  src.buffer = buf

  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 1.2
  filter.frequency.setValueAtTime(from, t)
  filter.frequency.exponentialRampToValueAtTime(to, t + dur)

  const env = c.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(gain, t + dur * 0.25)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)

  src.connect(filter).connect(env).connect(master!)
  src.start(t)
}

const EXTRA_CUES: Record<ExtraCue, () => void> = {
  interrupt: () => blip(440, { dur: 0.12, type: 'triangle', gain: 0.12 }),
  ack: () => blip(1046, { dur: 0.08, type: 'triangle', gain: 0.1 }),
  warning: () => {
    blip(660, { dur: 0.12, type: 'triangle', gain: 0.12 })
    blip(554, { at: 0.14, dur: 0.15, type: 'triangle', gain: 0.1 })
  },
  panelOpen: () => blip(1175, { dur: 0.09, type: 'triangle', gain: 0.08 }),
  panelClose: () => blip(784, { dur: 0.09, type: 'triangle', gain: 0.08 }),
  taskStart: () => blip(880, { dur: 0.13, type: 'triangle', gain: 0.1 }),
  taskPause: () => blip(587, { dur: 0.16, type: 'triangle', gain: 0.1 }),
  taskDone: () => blip(1318, { dur: 0.18, type: 'triangle', gain: 0.1 }),

  /**
   * Push-to-talk. The pair has to be unmistakable while being almost nothing:
   * it fires on every press and release, it lands directly before and after
   * speech, and the release cue overlaps the tail of the last word. So: very
   * short, quiet, and a rising/falling pair so open and closed are told apart
   * without listening for them.
   */
  micOpen: () => blip(784, { dur: 0.05, type: 'triangle', gain: 0.09, sweepTo: 1175 }),
  micClose: () => blip(1175, { dur: 0.06, type: 'triangle', gain: 0.07, sweepTo: 784 }),
}

let themeCues: Partial<Record<Cue, () => void>> | null = null

export function play(cue: Cue) {
  if (!ctx || ctx.state !== 'running') return

  const variants = samples.get(cue)
  if (variants?.length) {
    const index = chooseVariant(variants.length, previous.get(cue) ?? -1)
    previous.set(cue, index)
    const src = ctx.createBufferSource()
    src.buffer = variants[index]
    src.connect(master!)
    src.start()
    return
  }
  themeCues ??= activeThemePackage().sounds?.({ blip, noise }) ?? {}
  if (themeCues[cue]) themeCues[cue]()
  else if (cue in EXTRA_CUES) EXTRA_CUES[cue as ExtraCue]()
  else blip(cue === 'error' ? 220 : 660, { dur: 0.12, gain: 0.1 })
}

// ---------------------------------------------------------------------------
// Ambient bed
// ---------------------------------------------------------------------------

const AMBIENT = activeTheme().sound.ambient

/**
 * A quiet room tone under everything. Two detuned low oscillators through a
 * lowpass — barely audible on its own, but its absence is obvious. Keeps the
 * interface feeling powered rather than paused.
 *
 * For JARVIS this is only a fallback: when public/audio/ambient.mp3 is present
 * music.ts owns this layer.
 */
export function startAmbient() {
  if (ambient || !ctx || ctx.state !== 'running') return
  const c = ctx

  const gain = c.createGain()
  gain.gain.value = 0
  gain.connect(master!)

  const frames = c.sampleRate * 4
  const buf = c.createBuffer(1, frames, c.sampleRate)
  const data = buf.getChannelData(0)
  const profile = AMBIENT
  for (let i = 0; i < frames; i++) {
    const t = i / c.sampleRate
    data[i] =
      (Math.sin(2 * Math.PI * profile.tones[0] * t) * 0.5 +
        Math.sin(2 * Math.PI * profile.tones[1] * t) * 0.5 +
        (Math.random() * 2 - 1) * profile.noise) *
      0.5
  }

  const source = c.createBufferSource()
  source.buffer = buf
  source.loop = true

  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = profile.cutoff

  source.connect(lp).connect(gain)
  source.start()
  ambient = { source, gain }
  rampTo(gain.gain, profile.level, 3)
}

export function stopAmbient() {
  if (!ambient || !ctx) return
  const { source, gain } = ambient
  ambient = null
  rampTo(gain.gain, 0, 0.6)
  // Stop the node itself once it's inaudible, or it keeps a buffer looping in
  // the graph for as long as the page is open.
  setTimeout(() => {
    source.stop()
    source.disconnect()
    gain.disconnect()
  }, 800)
}

/**
 * Duck everything this module makes while JARVIS speaks.
 *
 * This used to touch only the synthesised bed, and return early when there
 * wasn't one — which there never is, because the ambient layer in the shipped
 * configuration comes from music.ts and startAmbient() below is a fallback
 * nothing currently calls. So it was a permanent no-op. The interface cues and
 * the bed both hang off the master, so ducking there is honest either way: with
 * the bed running it ducks the bed, and without it it still keeps a tool tick
 * or a completion chime from landing on top of a word.
 */
export function duck(on: boolean) {
  if (ducked === on || !master) return
  ducked = on
  // Out of the way quickly, back slowly — a fast recovery is audible as a
  // swell, and there is usually another sentence right behind the first.
  rampTo(master.gain, on ? volume * DUCK : volume, on ? 0.12 : 0.5)
}
