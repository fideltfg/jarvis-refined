import { useEffect, useState } from 'react'
import type { Phase } from '../store'

/**
 * The LCARS chrome: the two-part elbow frame down the left of the screen that
 * every TNG-era panel is built around.
 *
 * The upper frame is a short column that turns right into a thin bar; the
 * lower frame turns the other way, a thick bar that turns down into the long
 * column. The gap between them is the signature shape, and it is what makes
 * this read as LCARS rather than as a generic rounded-rectangle theme.
 *
 * Pure decoration: pointer-events are off, and the working parts of the HUD
 * (brand, status, rails, transcript) are positioned by lcars.css to sit inside
 * the spaces this frame leaves. The elbows follow the phase accent, so the
 * frame itself carries the state; the rest of the segments keep the fixed
 * panel palette, as real LCARS does.
 */

/**
 * A stardate in the TNG style — five digits and a tenth. Not canonical (no
 * formula ever was); it only has to tick forward believably and land in the
 * right register, which a thousand units a year from 1946 does.
 */
function stardate(now: Date): string {
  const start = Date.UTC(now.getUTCFullYear(), 0, 1)
  const days = (now.getTime() - start) / 86_400_000
  const value = (now.getUTCFullYear() - 1946) * 1000 + (days / 365.25) * 1000
  return value.toFixed(1)
}

/** Deterministic four-digit panel codes, so the frame does not reshuffle on
 *  every render — real panels hold their numbers still. */
const CODES = ['03-1147', '47-8812', '21-0459', '66-3020', '09-7731']

export function LcarsFrame({ phase }: { phase: Phase }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // A tenth of a stardate is about nine hours, so once a minute is plenty.
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  const busy = phase === 'thinking' || phase === 'tooling'

  return (
    <div className={`lc-frame${busy ? ' lc-busy' : ''}`} aria-hidden="true">
      <div className="lc-upper">
        <div className="lc-col">
          <div className="lc-blk lc-c-lilac">{CODES[0]}</div>
          <div className="lc-blk lc-c-tan lc-grow">
            <span className="lc-blk-k">stardate</span>
            {stardate(now)}
          </div>
        </div>
        <div className="lc-elbow lc-elbow-down" />
        <div className="lc-bar lc-bar-thin">
          <span className="lc-seg lc-c-orange" style={{ flex: 5 }} />
          <span className="lc-seg lc-c-lilac" style={{ flex: 1 }} />
          <span className="lc-seg lc-c-tan" style={{ flex: 2 }} />
          <span className="lc-seg lc-c-blue lc-cap" style={{ flex: 0.6 }} />
        </div>
      </div>

      <div className="lc-lower">
        <div className="lc-elbow lc-elbow-up" />
        <div className="lc-bar lc-bar-thick">
          <span className="lc-seg lc-c-violet" style={{ flex: 1.2 }} />
          <span className="lc-seg lc-c-orange lc-pulse" style={{ flex: 4 }} />
          <span className="lc-seg lc-c-lilac" style={{ flex: 1 }} />
          <span className="lc-seg lc-c-tan lc-cap" style={{ flex: 0.6 }} />
        </div>
        <div className="lc-col lc-col-long">
          <div className="lc-blk lc-c-red">{CODES[1]}</div>
          <div className="lc-blk lc-c-tan">{CODES[2]}</div>
          <div className="lc-blk lc-c-violet lc-grow">{CODES[3]}</div>
          <div className="lc-blk lc-c-lilac">{CODES[4]}</div>
        </div>
      </div>
    </div>
  )
}
