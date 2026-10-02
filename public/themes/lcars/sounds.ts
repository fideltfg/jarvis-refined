import type { ThemePackage } from '../../../src/lib/theme-package'

export const sounds: NonNullable<ThemePackage['sounds']> = ({ blip }) => ({
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
})
