import { useEffect, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { Phase } from '../store'

/**
 * The LCARS chrome, in the Voyager style: the two-part elbow frame down the
 * left of the screen that every panel aboard is built around.
 *
 * The upper frame is a short column that turns right into a thin bar; the
 * lower frame turns the other way, a thick bar that turns down into the long
 * column. The gap between them is the signature shape, and it is what makes
 * this read as LCARS rather than as a generic rounded-rectangle theme.
 *
 * What makes it Voyager rather than the Enterprise-D: the palette leans blue
 * and periwinkle with gold as the accent, and the panels are never quite
 * still. A bank of data cells in the thick bar blinks while the computer
 * works, the column codes churn, and a light sweeps the thin bar while it
 * speaks.
 *
 * Pure decoration: pointer-events are off, and the working parts of the HUD
 * (brand, status, rails, transcript) are positioned by lcars.css to sit inside
 * the spaces this frame leaves. The elbows follow the phase accent, so the
 * frame itself carries the state; the rest of the segments keep the fixed
 * panel palette, as real LCARS does.
 */

/**
 * A stardate in the Voyager register — five digits and a tenth. Not canonical
 * (no formula ever was); it only has to tick forward believably, and a
 * thousand units a year from 1976 lands this decade in the fifty-thousands,
 * where the ship spent its middle seasons.
 */
function stardate(now: Date): string {
  const start = Date.UTC(now.getUTCFullYear(), 0, 1)
  const days = (now.getTime() - start) / 86_400_000
  const value = (now.getUTCFullYear() - 1976) * 1000 + (days / 365.25) * 1000
  return value.toFixed(1)
}

/** Cheap deterministic noise, so a frame of churn is a pure function of its
 *  tick and nothing needs to be held in state. */
function hash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/** A panel code, `NN-NNNN`, fixed for tick 0 so a resting panel holds still. */
function code(slot: number, tick: number): string {
  const h = hash(slot * 97 + tick * 13)
  const a = Math.floor(h * 100).toString().padStart(2, '0')
  const b = Math.floor(hash(h * 1000 + slot) * 10_000).toString().padStart(4, '0')
  return `${a}-${b}`
}

const CELLS = 12

export function LcarsFrame({ phase }: { phase: Phase }) {
  const reduced = useReducedMotion()
  const [now, setNow] = useState(() => new Date())
  const [tick, setTick] = useState(0)

  const busy = phase === 'thinking' || phase === 'tooling'
  const speaking = phase === 'speaking'

  useEffect(() => {
    // A tenth of a stardate is about nine hours, so once a minute is plenty.
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    // The codes only churn while the computer is doing something; at rest the
    // panel holds its numbers still, which is what makes the churn read.
    if (!busy || reduced) return
    const id = setInterval(() => setTick((t) => t + 1), 700)
    return () => clearInterval(id)
  }, [busy, reduced])

  const t = busy ? tick : 0

  return (
    <div
      className={`lc-frame${busy ? ' lc-busy' : ''}${speaking ? ' lc-speaking' : ''}`}
      aria-hidden="true"
    >
      <div className="lc-upper">
        <div className="lc-col">
          <div className="lc-blk lc-c-sky">NCC-74656</div>
          <div className="lc-blk lc-c-tan lc-grow">
            <span className="lc-blk-k">stardate</span>
            {stardate(now)}
          </div>
        </div>
        <div className="lc-elbow lc-elbow-down" />
        <div className="lc-bar lc-bar-thin">
          <span className="lc-seg lc-c-violet" style={{ flex: 5 }} />
          <span className="lc-seg lc-c-gold" style={{ flex: 0.5 }} />
          <span className="lc-seg lc-c-lilac" style={{ flex: 1.5 }} />
          <span className="lc-seg lc-c-sky lc-cap" style={{ flex: 0.6 }} />
          <span className="lc-sweep" />
        </div>
      </div>

      <div className="lc-lower">
        <div className="lc-elbow lc-elbow-up" />
        <div className="lc-bar lc-bar-thick">
          <span className="lc-seg lc-c-navy" style={{ flex: 1.2 }} />
          <span className="lc-cells" style={{ flex: 3 }}>
            {Array.from({ length: CELLS }, (_, i) => (
              <span
                key={i}
                className={`lc-cell ${i % 4 === 3 ? 'lc-c-gold' : i % 3 === 0 ? 'lc-c-sky' : 'lc-c-violet'}`}
                style={{ animationDelay: `${Math.round(hash(i + 1) * 900)}ms` }}
              />
            ))}
          </span>
          <span className="lc-seg lc-c-lilac" style={{ flex: 1 }} />
          <span className="lc-seg lc-c-tan lc-cap" style={{ flex: 0.6 }} />
        </div>
        <div className="lc-col lc-col-long">
          <div className="lc-blk lc-c-peach">{code(1, t)}</div>
          <div className="lc-blk lc-c-sky">{code(2, t)}</div>
          <div className="lc-blk lc-c-violet lc-grow">{code(3, t)}</div>
          <div className="lc-blk lc-c-navy">{code(4, t)}</div>
          <div className="lc-blk lc-c-lilac">{code(5, t)}</div>
        </div>
      </div>
    </div>
  )
}
