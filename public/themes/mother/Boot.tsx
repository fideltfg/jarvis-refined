import { useBootClock } from '../../../src/lib/use-boot-clock'

const MOTHER_LOG = [
  ['INTERFACE', '2037'],
  ['CREW STATUS', '7 ACTIVE'],
  ['LIFE SUPPORT', 'PRIORITY ONE'],
  ['NAVIGATION', 'LOCKED'],
  ['SCIENCE OFFICER', 'SPECIAL ORDER 937'],
  ['QUERY CHANNEL', 'OPEN'],
]

export function Boot() {
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
