import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useStore } from '../store'

/**
 * The LCARS start-up: the U.S.S. Voyager's systems check.
 *
 * Three beats on one clock, the same shape as the Iron Man boot so App's
 * nine-second hand-off fits either:
 *   1. the frame slides in and the subsystem checklist runs down the left, each
 *      line resolving to ONLINE, while a data cascade churns on the right;
 *   2. the segmented bar along the bottom fills as the checks complete;
 *   3. the Starfleet delta draws itself in and access is granted.
 *
 * The clock is setInterval over wall time, not rAF, for the reason Boot.tsx
 * gives: rAF stalls in a background tab and the sequence would freeze.
 */

const T = { checks: 400, stride: 520, emblem: 5600 }

const CHECKS = [
  'MAIN COMPUTER CORE',
  'BIO-NEURAL GEL PACKS',
  'OPTICAL DATA NETWORK',
  'ASTROMETRICS',
  'SUBSPACE COMMUNICATIONS',
  'SENSOR ARRAYS',
  'VOICE INTERFACE',
  'DATABANK ACCESS',
]

const CASCADE_COLS = 6
const CASCADE_ROWS = 14
const TINTS = ['lc-t-blue', 'lc-t-violet', 'lc-t-ice', 'lc-t-lilac', 'lc-t-gold']

/** Cheap deterministic noise, so a frame of the cascade is a pure function of
 *  its tick and nothing needs to be held in state. */
function hash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

export function LcarsBoot() {
  const phase = useStore((s) => s.phase)
  const reduced = useReducedMotion()
  const [t, setT] = useState(0)

  useEffect(() => {
    if (phase !== 'boot') {
      setT(0)
      return
    }
    const start = Date.now()
    setT(0)
    const id = setInterval(() => setT(Date.now() - start), 50)
    return () => clearInterval(id)
  }, [phase])

  if (phase !== 'boot') return null

  const done = Math.max(0, Math.floor((t - T.checks) / T.stride))
  const progress = Math.min(1, done / CHECKS.length)
  // The cascade repaints at ~7fps: churn, not flicker.
  const tick = reduced ? 0 : Math.floor(t / 140)

  return (
    <div className="boot lcboot">
      <div className="lcboot-upper">
        <div className="lcboot-elbow" />
        <div className="lcboot-bar">
          <span className="lc-seg lc-c-violet" style={{ flex: 6 }} />
          <span className="lc-seg lc-c-gold" style={{ flex: 0.6 }} />
          <span className="lc-seg lc-c-lilac" style={{ flex: 1 }} />
          <span className="lc-seg lc-c-sky lc-cap" style={{ flex: 1 }} />
        </div>
        <div className="lcboot-title">
          <span className="lcboot-title-main">U.S.S. Voyager</span>
          <span className="lcboot-title-sub">NCC-74656 · LCARS systems check</span>
        </div>
      </div>

      <div className="lcboot-body">
        <div className="lcboot-checks">
          {CHECKS.map((name, i) => {
            const shown = i < done + 1 && t >= T.checks
            if (!shown) return null
            const ok = i < done
            return (
              <div key={name} className="lcboot-check">
                <span className="lcboot-check-name">{name}</span>
                <span className="lcboot-check-dots" />
                <span className={`lcboot-check-state${ok ? ' lcboot-ok' : ''}`}>
                  {ok ? 'ONLINE' : 'VERIFYING'}
                </span>
              </div>
            )
          })}
        </div>

        <div className="lcboot-cascade">
          {Array.from({ length: CASCADE_COLS }, (_, c) => (
            <div key={c} className="lcboot-cascade-col">
              {Array.from({ length: CASCADE_ROWS }, (_, r) => {
                const h = hash(c * 131 + r * 17 + tick * (1 + (c % 3)))
                const digits = 2 + Math.floor(hash(c * 7 + r) * 4)
                const value = Math.floor(h * 10 ** digits)
                  .toString()
                  .padStart(digits, '0')
                return (
                  <span key={r} className={TINTS[(c + r) % TINTS.length]}>
                    {value}
                  </span>
                )
              })}
            </div>
          ))}
        </div>

        {t >= T.emblem && (
          <div className="lcboot-emblem">
            <svg viewBox="-80 -80 160 160">
              <motion.ellipse
                cx="0"
                cy="4"
                rx="62"
                ry="44"
                className="lcboot-oval"
                initial={reduced ? { pathLength: 1 } : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.9, ease: 'easeInOut' }}
              />
              <motion.path
                className="lcboot-delta"
                d="M0,-66 C14,-30 28,20 38,62 C24,46 12,40 0,40 C-12,40 -24,46 -38,62 C-28,20 -14,-30 0,-66 Z"
                initial={reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8, delay: 0.3, ease: 'easeOut' }}
              />
            </svg>
            <motion.div
              className="lcboot-granted"
              initial={reduced ? { opacity: 1 } : { opacity: 0, letterSpacing: '0.6em' }}
              animate={{ opacity: 1, letterSpacing: '0.18em' }}
              transition={{ duration: 0.7, delay: 0.9 }}
            >
              LCARS access granted
            </motion.div>
          </div>
        )}
      </div>

      <div className="lcboot-lower">
        <div className="lcboot-elbow lcboot-elbow-up" />
        <div className="lcboot-progress">
          {Array.from({ length: 24 }, (_, i) => (
            <span key={i} className="lcboot-cell" data-on={i / 24 < progress ? '1' : '0'} />
          ))}
        </div>
      </div>
    </div>
  )
}
