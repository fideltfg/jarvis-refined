import type { ThemePackage } from '../../../src/lib/theme-package'

export const sounds: NonNullable<ThemePackage['sounds']> = ({ blip, noise }) => ({
  /** Play a long mechanical startup sweep and its final confirmation tone. */
  boot: () => {
    noise({ dur: 6.6, gain: 0.075, from: 90, to: 900 })
    blip(42, { dur: 6.8, type: 'sawtooth', gain: 0.08, sweepTo: 63 })
    ;[0.5, 1.25, 2.1, 3.05, 4.1, 5.2].forEach((at, index) => {
      // Add evenly spaced static bursts through the boot sequence.
      noise({ at, dur: 0.07, gain: 0.09, from: 2600, to: 420 })
      blip(index % 2 ? 196 : 174, { at, dur: 0.08, type: 'square', gain: 0.055 })
    })
    blip(294, { at: 6.5, dur: 0.65, type: 'triangle', gain: 0.13 })
  },
  /** Mark wake-word recognition with static and a confirmation tone. */
  wake: () => {
    noise({ dur: 0.08, gain: 0.07, from: 2400, to: 500 })
    blip(294, { at: 0.06, dur: 0.2, type: 'triangle', gain: 0.09 })
  },
  /** Indicate listening without masking microphone input. */
  listen: () => blip(220, { dur: 0.12, type: 'triangle', gain: 0.06 }),
  /** Signal tool execution with a static burst and low click. */
  tool: () => {
    noise({ dur: 0.09, gain: 0.065, from: 3200, to: 380 })
    blip(147, { at: 0.04, dur: 0.12, type: 'square', gain: 0.055 })
  },
  /** Confirm completion with a short low tone. */
  done: () => blip(294, { dur: 0.28, type: 'triangle', gain: 0.09 }),
  error: () => {
    blip(92, { dur: 0.42, type: 'square', gain: 0.11 })
    noise({ at: 0.1, dur: 0.35, gain: 0.06, from: 700, to: 120 })
  },
})
