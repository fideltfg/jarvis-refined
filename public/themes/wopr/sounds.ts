import type { ThemePackage } from '../../../src/lib/theme-package'

export const sounds: NonNullable<ThemePackage['sounds']> = ({ blip, noise }) => ({
  /** Play the data-burst boot sequence and settle into a low carrier hum. */
  boot: () => {
    noise({ dur: 1.4, gain: 0.08, from: 5000, to: 350 })
    const data = [440, 880, 587, 1174, 392, 784, 659, 1318, 523, 1046, 330, 660]
    data.forEach((freq, index) => {
      // Spread alternating data tones through the startup sequence.
      blip(freq, { at: 0.35 + index * 0.17, dur: 0.1, type: 'square', gain: 0.055 })
    })
    blip(110, { at: 2.7, dur: 3.8, type: 'sawtooth', gain: 0.04, sweepTo: 220 })
    blip(880, { at: 6.8, dur: 0.12, type: 'square', gain: 0.12 })
    blip(880, { at: 7.05, dur: 0.2, type: 'square', gain: 0.12 })
  },
  /** Play two telephone-like tones when WOPR is addressed. */
  wake: () => {
    blip(697, { dur: 0.08, type: 'square', gain: 0.1 })
    blip(1209, { at: 0.1, dur: 0.12, type: 'square', gain: 0.1 })
  },
  /** Mark the listening state with a single short square-wave pip. */
  listen: () => blip(880, { dur: 0.07, type: 'square', gain: 0.06 }),
  /** Add a three-tone data click when a tool starts. */
  tool: () => {
    ;[1760, 1174, 1568].forEach((freq, index) =>
      blip(freq, { at: index * 0.045, dur: 0.035, type: 'square', gain: 0.045 }),
    )
  },
  /** Play a descending pair when the assistant finishes a turn. */
  done: () => {
    blip(988, { dur: 0.08, type: 'square', gain: 0.08 })
    blip(659, { at: 0.1, dur: 0.14, type: 'square', gain: 0.07 })
  },
  /** Signal a failed operation with a low sawtooth tone. */
  error: () => blip(185, { dur: 0.62, type: 'sawtooth', gain: 0.12 }),
})
