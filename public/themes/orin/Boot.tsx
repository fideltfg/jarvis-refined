import { AnimatePresence, motion } from 'framer-motion'
import { useBootClock } from '../../../src/lib/use-boot-clock'

const ORIN_CHECKS = [
  'CONTROL PLANE',
  'VOICE CHANNEL',
  'SESSION CONTEXT',
  'REASONING CORE',
  'OUTPUT SURFACE',
]

export function Boot() {
  const elapsed = useBootClock()
  if (elapsed === null) return null

  const ready = elapsed >= 6900
  const progress = Math.min(100, Math.round((elapsed / 7600) * 100))

  return (
    <AnimatePresence>
      <motion.div
        className="boot classic-boot orin-boot"
        initial={false}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, filter: 'blur(8px)' }}
        transition={{ duration: 0.6 }}
      >
        <header className="orin-boot-head">
          <span>ORIN / STARTUP SEQUENCE</span>
          <span>OPERATIONAL REASONING INTERFACE</span>
        </header>
        <div className="orin-boot-layout">
          <section className="orin-boot-checks" aria-label="Startup diagnostics">
            {ORIN_CHECKS.map((check, index) => {
              const complete = elapsed >= (index + 1) * 760
              return (
                <div className="orin-boot-check" data-complete={complete} key={check}>
                  <span>{check}</span>
                  <span>{complete ? 'READY' : 'CHECKING'}</span>
                </div>
              )
            })}
          </section>
          <div className="orin-boot-core" aria-hidden="true">
            <span className="orin-boot-orbit" />
            <span className="orin-boot-bezel" />
            <span className="orin-boot-glow" />
            <span className="orin-boot-point" />
          </div>
        </div>
        <footer className="orin-boot-foot">
          <span>{ready ? 'INTERFACE READY' : 'INITIALISING INTERFACE'}</span>
          <span>{String(progress).padStart(3, '0')}%</span>
          <div className="orin-boot-progress"><i style={{ width: `${progress}%` }} /></div>
        </footer>
      </motion.div>
    </AnimatePresence>
  )
}
