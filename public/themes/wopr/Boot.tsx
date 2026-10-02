import { useBootClock } from '../../../src/lib/use-boot-clock'

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

export function Boot() {
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
