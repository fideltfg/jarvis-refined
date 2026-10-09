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

const WOPR_LED_BANKS = Array.from({ length: 3 }, (_, bank) =>
  Array.from({ length: 80 }, (_, led) => {
    const index = bank * 80 + led
    return {
      id: index,
      color: index % 17 === 0 ? 'white' : index % 3 === 0 ? 'red' : 'amber',
    }
  }),
)

/** Render the WOPR cabinet and light the LED banks for the current phase. */
export function Reactor({ inline = false }: { inline?: boolean } = {}) {
  const phase = useStore((state) => state.phase)
  const reactor = useStore((state) => state.ui.reactor)
  const ledThreshold = phase === 'offline' ? 16
    : phase === 'boot' ? 44
      : phase === 'dormant' ? 32
        : phase === 'listening' ? 42
          : phase === 'thinking' ? 55
            : phase === 'tooling' ? 51
              : phase === 'speaking' ? 46
                : 40
  const activeBank = phase === 'listening' ? 0
    : phase === 'thinking' || phase === 'tooling' ? 1
      : phase === 'speaking' ? 2
        : -1
  const className = 'character-reactor wopr-reactor'
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
      <div className="wopr-machine">
          <div className="wopr-console-base">
            <div className="wopr-indicators" data-phase={phase}>
              {WOPR_LED_BANKS.map((bank, bankIndex) => (
                // Keep each status bank associated with its phase role.
                <div className="wopr-led-bank" key={bankIndex}>
                  {bank.map((led) => {
                    // Deterministically light a phase-dependent subset of LEDs.
                    const threshold = ledThreshold + (bankIndex === activeBank ? 16 : 0)
                    const lit = (led.id * 17 + bankIndex * 11) % 80 < threshold
                    return (
                      <span
                        className="wopr-led"
                        data-color={led.color}
                        data-lit={lit}
                        key={led.id}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="wopr-panel-door" />
            <div className="wopr-panel-service" />
            <div className="wopr-panel-door" />
          </div>
          <div className="wopr-display-housing">
            <div className="wopr-display-window">
              <div className="wopr-led-copy">
                <span>WOPR SYSTEM ONLINE</span>
                <span>{PHASE_LABELS[phase]}</span>
              </div>
            </div>
            <strong>WOPR</strong>
            <span className="wopr-model-sub">WAR OPERATION PLAN RESPONSE</span>
          </div>
        </div>
    </div>
  )
}
