import type { ThemePackage } from '../../../src/lib/theme-package'

export const sounds: NonNullable<ThemePackage['sounds']> = ({ blip, noise }) => ({
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
})
