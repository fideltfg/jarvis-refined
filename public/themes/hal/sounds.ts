import type { ThemePackage } from '../../../src/lib/theme-package'

export const sounds: NonNullable<ThemePackage['sounds']> = ({ blip }) => ({
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
})
