import { useStore } from '../../../src/store'

const PHASE_LABELS: Record<string, string> = {
  offline: 'SYSTEM OFFLINE',
  boot: 'INITIALISING',
  dormant: 'AWAITING INPUT',
  waking: 'LINK ESTABLISHED',
  listening: 'INPUT RECEIVING',
  thinking: 'PROCESSING',
  tooling: 'ACCESSING SYSTEMS',
  speaking: 'TRANSMITTING',
}

export function Reactor({ inline = false }: { inline?: boolean } = {}) {
  const level = useStore((state) => state.level)
  const phase = useStore((state) => state.phase)
  const reactor = useStore((state) => state.ui.reactor)
  const className = 'character-reactor mother-reactor'
  const style = {
    '--reactor-scale': reactor.scale,
    // Spin was reaching the store but never the stylesheet, so ui_reactor's
    // spin had no effect on any character reactor. Clamped above zero because
    // it divides an animation duration.
    '--reactor-spin': Math.max(reactor.spin, 0.2),
    opacity: reactor.visible ? reactor.intensity : 0,
  } as React.CSSProperties

  return (
    <div className={className} style={style} aria-hidden="true" data-visible={reactor.visible} data-inline={inline ? 'true' : undefined}>
      <div className="crt-live-screen">
          <header>
            <span>MU/TH/UR 6000 // MAINFRAME</span>
            <span>SHIP SYSTEMS</span>
          </header>
          <div className="crt-live-rule" />
          <div className="crt-live-copy">
            <p>INTERFACE STATUS <b>{PHASE_LABELS[phase]}</b></p>
            <p>PRIORITY <b>{phase === 'thinking' || phase === 'tooling' ? 'ACTIVE' : 'STANDBY'}</b></p>
            <p>Awaiting authorised instruction.</p>
          </div>
          <div className="crt-live-meter" style={{ '--meter': `${Math.round(level * 100)}%` } as React.CSSProperties}>
            <span />
          </div>
          <footer><span>INPUT {Math.round(level * 100).toString().padStart(2, '0')}%</span><span className="crt-live-cursor">_</span></footer>
        </div>
    </div>
  )
}
