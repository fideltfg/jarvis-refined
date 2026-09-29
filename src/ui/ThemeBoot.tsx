import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { THEME } from '../config'
import { useStore } from '../store'
import { Boot } from './Boot'
import { LcarsBoot } from './LcarsBoot'

function useBootClock() {
  const phase = useStore((state) => state.phase)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (phase !== 'boot') {
      setElapsed(0)
      return
    }
    const started = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - started), 50)
    return () => clearInterval(id)
  }, [phase])

  return phase === 'boot' ? elapsed : null
}

const HAL_CHECKS = [
  'LOGIC MEMORY',
  'AE-35 TELEMETRY',
  'VOICE ANALYSIS',
  'MISSION PARAMETERS',
  'COGNITIVE CIRCUITS',
]

function HalBoot() {
  const elapsed = useBootClock()
  const reduced = useReducedMotion()
  if (elapsed === null) return null

  const checks = Math.min(HAL_CHECKS.length, Math.floor(elapsed / 620))
  const awake = elapsed >= 3400
  const ready = elapsed >= 6900

  return (
    <div className="boot classic-boot hal-boot">
      <div className="hal-boot-model">9000 SERIES // HEURISTIC CORE</div>
      <div className="hal-boot-checks">
        {HAL_CHECKS.map((check, index) => (
          <div className="hal-boot-check" data-on={index < checks ? '1' : '0'} key={check}>
            <span>{check}</span>
            <span>{index < checks ? 'NOMINAL' : '—'}</span>
          </div>
        ))}
      </div>
      <motion.div
        className="hal-lens"
        initial={reduced ? false : { opacity: 0, scale: 0.72 }}
        animate={awake ? { opacity: 1, scale: 1 } : { opacity: 0.08, scale: 0.72 }}
        transition={{ duration: 1.8, ease: 'easeOut' }}
      >
        <span className="hal-lens-bezel" />
        <span className="hal-lens-glass" />
        <span className="hal-lens-core" />
      </motion.div>
      <div className="hal-boot-scan" />
      <motion.div
        className="hal-boot-ready"
        animate={{ opacity: ready ? 1 : 0 }}
        transition={{ duration: 1.2 }}
      >
        ALL SYSTEMS OPERATIONAL
      </motion.div>
    </div>
  )
}

const WOPR_LOG = [
  'CONNECTING TO IMSAI NET 4',
  'MODEM CARRIER ........ 1200 BAUD',
  'NORAD SIOP DATABASE .. LINKED',
  'LAUNCH MATRIX ........ LOADED',
  'SIMULATION ENGINE .... READY',
  'USER: JOSHUA',
]

const WOPR_NODES = [
  [14, 62], [23, 38], [35, 69], [48, 30], [57, 55], [68, 24], [77, 67], [88, 42],
]

function WoprBoot() {
  const elapsed = useBootClock()
  if (elapsed === null) return null

  const lines = Math.min(WOPR_LOG.length, Math.floor(elapsed / 520))
  const mapOn = elapsed >= 3500
  const decision = elapsed >= 7000

  return (
    <div className="boot classic-boot wopr-boot">
      <div className="wopr-terminal-head">WOPR EXEC 4.3.2 // REMOTE SESSION</div>
      <div className="wopr-log">
        {WOPR_LOG.slice(0, lines).map((line) => <div key={line}>&gt; {line}</div>)}
        <span className="wopr-cursor">_</span>
      </div>
      <div className="wopr-map" data-on={mapOn ? '1' : '0'}>
        <div className="wopr-map-grid" />
        <div className="wopr-trajectory wopr-trajectory-a" />
        <div className="wopr-trajectory wopr-trajectory-b" />
        {WOPR_NODES.map(([left, top], index) => (
          <span
            className="wopr-node"
            key={`${left}-${top}`}
            style={{ left: `${left}%`, top: `${top}%`, animationDelay: `${index * 110}ms` }}
          />
        ))}
      </div>
      <div className="wopr-defcon">
        {[5, 4, 3, 2, 1].map((level) => <span key={level}>DEFCON {level}</span>)}
      </div>
      {decision && <div className="wopr-question">SHALL WE PLAY A GAME?<span>_</span></div>}
    </div>
  )
}

const MOTHER_LOG = [
  ['INTERFACE', '2037'],
  ['CREW STATUS', '7 ACTIVE'],
  ['LIFE SUPPORT', 'PRIORITY ONE'],
  ['NAVIGATION', 'LOCKED'],
  ['SCIENCE OFFICER', 'SPECIAL ORDER 937'],
  ['QUERY CHANNEL', 'OPEN'],
]

function MotherBoot() {
  const elapsed = useBootClock()
  if (elapsed === null) return null

  const lines = Math.min(MOTHER_LOG.length, Math.floor(elapsed / 680))
  const granted = elapsed >= 6100

  return (
    <div className="boot classic-boot mother-boot">
      <div className="mother-shutter mother-shutter-top" />
      <div className="mother-shutter mother-shutter-bottom" />
      <div className="mother-terminal">
        <header>
          <span>MU/TH/UR 6000</span>
          <span>SCIENCE OFFICER TERMINAL</span>
        </header>
        <div className="mother-rule" />
        <div className="mother-log">
          {MOTHER_LOG.slice(0, lines).map(([label, value], index) => (
            <div key={label} style={{ animationDelay: `${index * 70}ms` }}>
              <span>{String(index + 1).padStart(2, '0')} / {label}</span>
              <span>{value}</span>
            </div>
          ))}
        </div>
        <div className="mother-priority" data-on={granted ? '1' : '0'}>
          <span>PRIORITY ACCESS</span>
          <strong>{granted ? 'GRANTED' : 'VERIFYING'}</strong>
        </div>
        <div className="mother-prompt">READY FOR QUERY <span>█</span></div>
      </div>
    </div>
  )
}

export function ThemeBoot() {
  if (THEME === 'hal') return <HalBoot />
  if (THEME === 'wopr') return <WoprBoot />
  if (THEME === 'mother') return <MotherBoot />
  if (THEME === 'lcars') return <LcarsBoot />
  return <Boot />
}