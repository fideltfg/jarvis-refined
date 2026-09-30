import { activeTheme } from '../lib/theme-runtime'
import { useStore } from '../store'

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

const LCARS_VALUES = [
  ['CORE TEMP', '021'], ['AUX POWER', '008'], ['SHIELDS', '065'],
  ['WARP FIELD', '358'], ['LIFE SUPPORT', '752'], ['SENSORS', '068'],
  ['NAV ARRAY', '089'], ['COMMS', '017'], ['ENGINE', '051'],
  ['PHASERS', '826'], ['DEFLECTOR', '019'], ['FLUX', '408'],
]

const WOPR_LED_BANKS = Array.from({ length: 3 }, (_, bank) =>
  Array.from({ length: 80 }, (_, led) => {
    const index = bank * 80 + led
    return {
      id: index,
      color: index % 17 === 0 ? 'white' : index % 3 === 0 ? 'red' : 'amber',
    }
  }),
)

export function CharacterReactor({ inline = false }: { inline?: boolean } = {}) {
  const theme = activeTheme().id
  const level = useStore((state) => state.level)
  const phase = useStore((state) => state.phase)
  const reactor = useStore((state) => state.ui.reactor)

  if (!['hal', 'wopr', 'mother', 'lcars', 'orin'].includes(theme)) return null
  if (theme === 'orin' && !inline) return null

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

  const className = `character-reactor ${theme}-reactor`
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
      {theme === 'hal' && (
        <div className="hal-live-lens">
          <span className="hal-live-bezel" />
          <span className="hal-live-glass" />
          <span className="hal-live-reflection" />
          <span className="hal-live-core" />
        </div>
      )}

      {theme === 'orin' && (
        <div className="orin-live-lens" data-phase={phase} style={{ '--level': level } as React.CSSProperties}>
          <span className="orin-lens-orbit" />
          <span className="orin-lens-bezel" />
          <span className="orin-lens-well" />
          <span className="orin-lens-glass" />
          <span className="orin-lens-ring orin-lens-ring-outer" />
          <span className="orin-lens-ring orin-lens-ring-inner" />
          <span className="orin-lens-highlight" />
        </div>
      )}

      {theme === 'wopr' && (
        <div className="wopr-machine">
          <div className="wopr-console-base">
            <div className="wopr-indicators" data-phase={phase}>
              {WOPR_LED_BANKS.map((bank, bankIndex) => (
                <div className="wopr-led-bank" key={bankIndex}>
                  {bank.map((led) => {
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
      )}

      {theme === 'mother' && (
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
      )}

      {theme === 'lcars' && (
        <div className="lcars-reactor-panel">
          <div className="lcars-panel-head">
            <span>MAIN COMPUTER CORE</span>
            <span>LCARS / 47-A</span>
          </div>
          <div className="lcars-panel-grid">
            {LCARS_VALUES.map(([label, value], index) => (
              <div className={`lcars-readout lcars-readout-${index % 5}`} key={label}>
                <span>{label}</span><b>{index === 0 ? String(Math.round(21 + level * 8)).padStart(3, '0') : value}</b>
              </div>
            ))}
          </div>
          <div className="lcars-panel-footer">
            <span className="lcars-phase">{PHASE_LABELS[phase]}</span>
            <span className="lcars-signal"><i style={{ width: `${Math.max(8, level * 100)}%` }} /></span>
            <span>{String(Math.round(level * 100)).padStart(3, '0')}%</span>
          </div>
        </div>
      )}
    </div>
  )
}