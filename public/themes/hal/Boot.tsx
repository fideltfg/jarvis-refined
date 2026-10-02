import { motion, useReducedMotion } from 'framer-motion'
import { useBootClock } from '../../../src/lib/use-boot-clock'

const HAL_CHECKS = [
  'LOGIC MEMORY',
  'AE-35 TELEMETRY',
  'VOICE ANALYSIS',
  'MISSION PARAMETERS',
  'COGNITIVE CIRCUITS',
]

export function Boot() {
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
