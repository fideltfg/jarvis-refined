/**
 * Sound design.
 *
 * Every cue is synthesised in Web Audio rather than shipped as a file, so the
 * app makes the right noises the moment you clone it — nothing to download, no
 * licence to worry about, a few hundred bytes instead of a few megabytes.
 *
 * To use real recordings instead, drop matching files into a theme's own
 * `audio/` folder (`public/themes/<id>/audio/`) or the shared `public/audio/`.
 * Numbered variants such as wake-1.mp3 and
 * wake-2.mp3 rotate randomly without an immediate repeat. They take over
 * automatically. Pixabay's sci-fi UI and HUD packs are the usual source —
 * CC0, no attribution, safe on a monetised channel. `ambient.mp3` is not one of
 * these: the looping bed is music.ts's, and the oscillator pair at the bottom of
 * this file is only the fallback for when that file isn't there.
 */

import { activeTheme } from './theme-runtime'
import { chooseVariant, fileStem } from './sfx-variants'

type BaseCue = 'boot' | 'wake' | 'listen' | 'tool' | 'done' | 'error'
type ExtraCue = 'interrupt' | 'ack' | 'warning' | 'panelOpen' | 'panelClose' | 'taskStart' | 'taskPause' | 'taskDone'
type Cue = BaseCue | ExtraCue

const CUES: Cue[] = [
  'boot', 'wake', 'listen', 'tool', 'done', 'error', 'interrupt', 'ack', 'warning',
  'panelOpen', 'panelClose', 'taskStart', 'taskPause', 'taskDone',
]

/**
 * Where recordings are looked for, nearest first: the theme's own folder, then
 * the shared one. A theme package is self-contained, but a set of cues shared
 * by every character does not have to be copied into all of them.
 */
const OVERRIDE_DIRS = [`${activeTheme().dir}/audio`, '/audio']

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

// ---------------------------------------------------------------------------

const synth: Record<BaseCue, () => void> = {
  /** Reactor spin-up: a rising sweep under stacked fifths. */
  boot: () => {
    noise({ dur: 2.2, gain: 0.1, from: 120, to: 5200 })
    blip(110, { dur: 2.4, type: 'sawtooth', gain: 0.1, sweepTo: 880 })
    blip(220, { at: 0.1, dur: 2.2, type: 'sine', gain: 0.09, sweepTo: 1320 })
    // The "online" confirmation — a clean rising third.
    blip(880, { at: 1.9, dur: 0.3, gain: 0.18 })
    blip(1320, { at: 2.05, dur: 0.45, gain: 0.2 })
  },

  /** Wake: two quick ascending pips. Deliberately short. */
  wake: () => {
    blip(1046, { dur: 0.09, gain: 0.22 })
    blip(1568, { at: 0.07, dur: 0.14, gain: 0.2 })
  },

  /** Listening: a single soft low pip so it doesn't fight the user's voice. */
  listen: () => blip(660, { dur: 0.1, gain: 0.14 }),

  /** A tool fired — a tiny mechanical tick. */
  tool: () => {
    blip(2200, { dur: 0.05, type: 'square', gain: 0.07 })
    noise({ dur: 0.1, gain: 0.05, from: 3000, to: 900 })
  },

  /** Turn complete: a descending pair, the inverse of wake. */
  done: () => {
    blip(1320, { dur: 0.1, gain: 0.14 })
    blip(880, { at: 0.08, dur: 0.2, gain: 0.13 })
  },

  /** Something failed — flat, slightly dissonant, not alarming. */
  error: () => {
    blip(320, { dur: 0.18, type: 'square', gain: 0.14 })
    blip(226, { at: 0.13, dur: 0.3, type: 'square', gain: 0.12 })
  },
}

/** Sparse, rounded tones: a large machine speaking through one perfect lens. */
const hal: Record<BaseCue, () => void> = {
  boot: () => {
    blip(48, { dur: 6.4, type: 'sine', gain: 0.16, sweepTo: 72 })
    blip(96, { at: 0.4, dur: 5.8, type: 'sine', gain: 0.05, sweepTo: 144 })
    blip(523, { at: 3.2, dur: 1.1, type: 'sine', gain: 0.12 })
    blip(659, { at: 6.7, dur: 0.8, type: 'sine', gain: 0.16 })
  },
  wake: () => blip(523, { dur: 0.42, type: 'sine', gain: 0.18 }),
  listen: () => blip(392, { dur: 0.18, type: 'sine', gain: 0.08 }),
  tool: () => {
    blip(174, { dur: 0.07, type: 'sine', gain: 0.1 })
    blip(261, { at: 0.12, dur: 0.16, type: 'sine', gain: 0.09 })
  },
  done: () => blip(659, { dur: 0.36, type: 'sine', gain: 0.12 }),
  error: () => {
    blip(82, { dur: 0.55, type: 'sine', gain: 0.18 })
    blip(87, { at: 0.04, dur: 0.58, type: 'sine', gain: 0.12 })
  },
}

/** Hard-edged command-terminal tones, with boot chatter that reads as a modem. */
const wopr: Record<BaseCue, () => void> = {
  boot: () => {
    noise({ dur: 1.4, gain: 0.08, from: 5000, to: 350 })
    const data = [440, 880, 587, 1174, 392, 784, 659, 1318, 523, 1046, 330, 660]
    data.forEach((freq, index) =>
      blip(freq, { at: 0.35 + index * 0.17, dur: 0.1, type: 'square', gain: 0.055 }),
    )
    blip(110, { at: 2.7, dur: 3.8, type: 'sawtooth', gain: 0.04, sweepTo: 220 })
    blip(880, { at: 6.8, dur: 0.12, type: 'square', gain: 0.12 })
    blip(880, { at: 7.05, dur: 0.2, type: 'square', gain: 0.12 })
  },
  wake: () => {
    blip(697, { dur: 0.08, type: 'square', gain: 0.1 })
    blip(1209, { at: 0.1, dur: 0.12, type: 'square', gain: 0.1 })
  },
  listen: () => blip(880, { dur: 0.07, type: 'square', gain: 0.06 }),
  tool: () => {
    ;[1760, 1174, 1568].forEach((freq, index) =>
      blip(freq, { at: index * 0.045, dur: 0.035, type: 'square', gain: 0.045 }),
    )
  },
  done: () => {
    blip(988, { dur: 0.08, type: 'square', gain: 0.08 })
    blip(659, { at: 0.1, dur: 0.14, type: 'square', gain: 0.07 })
  },
  error: () => blip(185, { dur: 0.62, type: 'sawtooth', gain: 0.12 }),
}

/** Relays, ventilation and blunt terminal acknowledgements for an old ship core. */
const mother: Record<BaseCue, () => void> = {
  boot: () => {
    noise({ dur: 6.6, gain: 0.075, from: 90, to: 900 })
    blip(42, { dur: 6.8, type: 'sawtooth', gain: 0.08, sweepTo: 63 })
    ;[0.5, 1.25, 2.1, 3.05, 4.1, 5.2].forEach((at, index) => {
      noise({ at, dur: 0.07, gain: 0.09, from: 2600, to: 420 })
      blip(index % 2 ? 196 : 174, { at, dur: 0.08, type: 'square', gain: 0.055 })
    })
    blip(294, { at: 6.5, dur: 0.65, type: 'triangle', gain: 0.13 })
  },
  wake: () => {
    noise({ dur: 0.08, gain: 0.07, from: 2400, to: 500 })
    blip(294, { at: 0.06, dur: 0.2, type: 'triangle', gain: 0.09 })
  },
  listen: () => blip(220, { dur: 0.12, type: 'triangle', gain: 0.06 }),
  tool: () => {
    noise({ dur: 0.09, gain: 0.065, from: 3200, to: 380 })
    blip(147, { at: 0.04, dur: 0.12, type: 'square', gain: 0.055 })
  },
  done: () => blip(294, { dur: 0.28, type: 'triangle', gain: 0.09 }),
  error: () => {
    blip(92, { dur: 0.42, type: 'square', gain: 0.11 })
    noise({ at: 0.1, dur: 0.35, gain: 0.06, from: 700, to: 120 })
  },
}

/**
 * The starship set. LCARS panels talk in short, pure, slightly hollow tones —
 * triangle waves, high register, no sweeps, no noise — stepped rather than
 * glided. The shapes follow the show's grammar: a rising pair when the
 * computer is ready for you, a falling pair when it is done, and a flat low
 * double for "unable to comply".
 */
const lcars: Record<BaseCue, () => void> = {
  /** Power-up: the engine hum rising under a run of panel chatter, then the
   *  ready chirp. */
  boot: () => {
    blip(55, { dur: 2.6, type: 'sine', gain: 0.16, sweepTo: 110 })
    blip(110, { at: 0.2, dur: 2.4, type: 'triangle', gain: 0.05, sweepTo: 220 })
    const run = [1568, 2093, 1760, 2349, 1397, 1976, 2637, 1760, 2093, 1568]
    run.forEach((f, i) =>
      blip(f, { at: 0.25 + i * 0.13, dur: 0.07, type: 'triangle', gain: 0.1 }),
    )
    blip(1318, { at: 1.95, dur: 0.1, type: 'triangle', gain: 0.18 })
    blip(1760, { at: 2.06, dur: 0.22, type: 'triangle', gain: 0.18 })
  },

  /** "Computer." — the rising two-tone that means it is listening. */
  wake: () => {
    blip(1318, { dur: 0.08, type: 'triangle', gain: 0.2 })
    blip(1976, { at: 0.085, dur: 0.16, type: 'triangle', gain: 0.2 })
  },

  /** A single soft tone, low enough to stay out from under the user's voice. */
  listen: () => blip(1175, { dur: 0.08, type: 'triangle', gain: 0.1 }),

  /** A panel touch: two quick taps. */
  tool: () => {
    blip(2349, { dur: 0.04, type: 'triangle', gain: 0.09 })
    blip(1760, { at: 0.05, dur: 0.05, type: 'triangle', gain: 0.08 })
  },

  /** Done: the falling pair, the inverse of wake. */
  done: () => {
    blip(1976, { dur: 0.07, type: 'triangle', gain: 0.14 })
    blip(1318, { at: 0.08, dur: 0.16, type: 'triangle', gain: 0.13 })
  },

  /** Unable to comply: two flat, low, identical buzzes. */
  error: () => {
    blip(392, { dur: 0.16, type: 'square', gain: 0.1 })
    blip(392, { at: 0.2, dur: 0.22, type: 'square', gain: 0.1 })
  },
}

/**
 * The synthesised banks, by the name a manifest can ask for. A theme naming
 * one that does not exist gets the stock bank rather than silence.
 */
const CUE_BANKS: Record<string, Record<BaseCue, () => void>> = {
  stark: synth,
  hal,
  wopr,
  mother,
  lcars,
}

const BANK = CUE_BANKS[activeTheme().sound.bank] ?? synth

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
}

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
  if (cue in EXTRA_CUES) EXTRA_CUES[cue as ExtraCue]()
  else BANK[cue as BaseCue]()
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
