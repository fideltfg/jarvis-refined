import { useEffect, useRef } from 'react'
import { useStore } from '../../../src/store'

const BARS = 32
const FLOOR = 0.14

// The bars used to be a pure CSS keyframe animation with a fixed per-bar
// target, so they never saw the mic at all — paused they read as a static row
// of dots. They are driven from the live `level` in the store instead, which is
// the mic while listening and JARVIS's own output while speaking.
//
// Deliberately imperative: the level pump updates every animation frame, and
// subscribing to it with a hook would re-render the whole ORIN dashboard 60
// times a second. This writes one CSS variable per bar and never re-renders.
export function OrinWave() {
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = wrap.current
    if (!host) return
    const bars = Array.from(host.querySelectorAll<HTMLElement>('i'))
    if (!bars.length) return

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (still) return

    // Per-bar wobble, so a single scalar level still reads as a voice rather
    // than 32 bars moving as one block.
    const speed = bars.map((_, i) => 3.1 + ((i * 7) % 11) * 0.42)
    const phase = bars.map((_, i) => ((i * 13) % 29) / 29 * Math.PI * 2)
    const centre = (BARS - 1) / 2
    const envelope = bars.map((_, i) => 0.42 + 0.58 * (1 - Math.abs(i - centre) / centre) ** 0.7)
    const held = bars.map(() => FLOOR)

    let raf = 0
    const tick = (time: number) => {
      const state = useStore.getState()
      const live = state.phase === 'listening' || state.phase === 'speaking'
      const level = live ? Math.min(1, Math.max(0, state.level)) : 0
      const t = time / 1000

      for (let i = 0; i < bars.length; i += 1) {
        const wobble = 0.5 + 0.5 * Math.sin(t * speed[i] + phase[i]) * Math.cos(t * speed[i] * 0.37 + phase[i] * 1.7)
        const jitter = 0.88 + Math.random() * 0.24
        const target = Math.min(1, FLOOR + level * envelope[i] * (0.3 + 0.7 * wobble) * jitter * 1.6)
        // Snap up, fall back slowly — a level meter that decays reads as speech.
        const ease = target > held[i] ? 0.55 : 0.14
        held[i] += (target - held[i]) * ease
        bars[i].style.setProperty('--bar', held[i].toFixed(3))
      }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const phase = useStore((state) => state.phase)

  return (
    <div
      className="orin-wave"
      ref={wrap}
      data-active={phase === 'listening' || phase === 'speaking'}
      aria-hidden="true"
    >
      {Array.from({ length: BARS }, (_, index) => (
        <i key={index} style={{ '--bar': FLOOR } as React.CSSProperties} />
      ))}
    </div>
  )
}
