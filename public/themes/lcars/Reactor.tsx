import { useEffect, useRef, useState } from 'react'
import { AudioLines, Camera, ClipboardList, Mic, MicOff, Send, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import { providerState, selectProvider, usingBridge, watchProviders } from '../../../src/lib/brain'
import { useStore, type Phase } from '../../../src/store'
import { AgentBoard } from '../../../src/ui/AgentBoard'
import { Diagnostics } from '../../../src/ui/Diagnostics'

const PHASE_LABELS: Record<Phase, string> = {
  offline: 'OFFLINE',
  boot: 'INITIALISING',
  dormant: 'STANDBY',
  waking: 'WAKING',
  listening: 'LISTENING',
  thinking: 'COMPUTING',
  tooling: 'TOOL ACCESS',
  speaking: 'TRANSMITTING',
}

const TRACE_SAMPLES = 56

export function Reactor({ inline = false }: { inline?: boolean } = {}) {
  const level = useStore((state) => state.level)
  const phase = useStore((state) => state.phase)
  const activeTool = useStore((state) => state.activeTool)
  const connected = useStore((state) => state.connected)
  const agentsOnline = useStore((state) => state.agentsOnline)
  const sessionAgents = useStore((state) => state.sessionAgents)
  const gestures = useStore((state) => state.gestures)
  const turns = useStore((state) => state.turns)
  const caption = useStore((state) => state.caption)
  const error = useStore((state) => state.error)
  const ptt = useStore((state) => state.ptt)
  const enrolling = useStore((state) => state.enrolling)
  const boardOpen = useStore((state) => state.boardOpen)
  const agentsSeen = useStore((state) => state.agentsSeen)
  const toggleBoard = useStore((state) => state.toggleBoard)
  const clearScreen = useStore((state) => state.clearScreen)
  const reactor = useStore((state) => state.ui.reactor)
  const [trace, setTrace] = useState<number[]>(() => Array(TRACE_SAMPLES).fill(0))
  const [command, setCommand] = useState('')
  const [providers, setProviders] = useState(providerState)
  const levelRef = useRef(level)
  levelRef.current = level

  useEffect(() => {
    const id = window.setInterval(() => {
      setTrace((samples) => [...samples.slice(1), levelRef.current])
    }, 120)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => watchProviders((available, selected) => setProviders({ available, selected })), [])

  const className = 'character-reactor lcars-reactor'
  const style = {
    '--reactor-scale': reactor.scale,
    opacity: reactor.visible ? reactor.intensity : 0,
  } as React.CSSProperties
  const boundedLevel = Math.max(0, Math.min(1, level))
  const unavailable = phase === 'offline' || phase === 'boot'
  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'
  const tracePath = trace
    .map((sample, index) => {
      const x = (index / (TRACE_SAMPLES - 1)) * 480
      const y = 75 - Math.max(0, Math.min(1, sample)) * 58
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    })
    .join(' ')

  const systems = [
    { name: 'VOICE LOOP', state: phase === 'offline' ? 'OFFLINE' : 'READY', on: phase !== 'offline', tone: 'mint' },
    { name: 'AUDIO INPUT', state: phase === 'offline' ? 'OFFLINE' : boundedLevel > 0.015 ? 'ACTIVE' : 'ARMED', on: phase !== 'offline', tone: 'orange', level: boundedLevel },
    { name: 'TOOL CHANNEL', state: activeTool ?? 'IDLE', on: Boolean(activeTool), tone: 'lilac' },
    { name: 'VISION TRACKING', state: gestures ? 'TRACKING' : 'STANDBY', on: gestures, tone: 'blue' },
    { name: 'AGENT NETWORK', state: agentsOnline ? `${sessionAgents.length} SESSION${sessionAgents.length === 1 ? '' : 'S'}` : 'NOT CONNECTED', on: agentsOnline, tone: 'mint' },
  ]

  return (
    <div className={className} style={style} data-visible={reactor.visible} data-inline={inline ? 'true' : undefined}>
      <main className="lcars-reactor-console">
        <header className="lcars-reactor-heading">
          <div>
            <span className="lcars-reactor-eyebrow">FLIGHT SYSTEMS / OPERATIONS</span>
            <h1>Computer core</h1>
          </div>
          <div className="lcars-reactor-phase">
            <i className={`lcars-phase-light${phase !== 'offline' ? ' is-live' : ''}`} />
            <span>{PHASE_LABELS[phase]}</span>
          </div>
        </header>

        <div className="lcars-reactor-grid">
          <section className="lcars-signal-panel">
            <div className="lcars-section-heading">
              <div>
                <span className="lcars-reactor-eyebrow">CHANNEL 01 / INPUT</span>
                <h2>Audio signal</h2>
              </div>
              <div className="lcars-live-readout">
                <span>LEVEL</span>
                <b>{String(Math.round(boundedLevel * 100)).padStart(3, '0')}<small>%</small></b>
              </div>
            </div>

            <div className="lcars-core-visual" data-active={phase === 'listening' ? 'true' : 'false'}>
              <div className="lcars-core-orbit lcars-core-orbit-a" />
              <div className="lcars-core-orbit lcars-core-orbit-b" />
              <div className="lcars-core-orbit lcars-core-orbit-c" />
              <div className="lcars-core-center">
                <span>MIC INPUT</span>
                <b>{Math.round(boundedLevel * 100)}<small>%</small></b>
              </div>
            </div>

            <div className="lcars-wave-wrap">
              <div className="lcars-wave-grid" />
              <svg className="lcars-wave" viewBox="0 0 480 150" preserveAspectRatio="none" role="presentation">
                <path className="lcars-wave-fill" d={`${tracePath} L 480 150 L 0 150 Z`} />
                <path className="lcars-wave-line" d={tracePath} />
              </svg>
            </div>
            <div className="lcars-chart-axis">
              <span>-6 SEC</span><span>LIVE INPUT</span><span>NOW</span>
            </div>

            <div className="lcars-signal-footer">
              <span><i className="lcars-signal-dot" />{phase === 'listening' ? 'CAPTURING VOICE' : 'CHANNEL MONITORING'}</span>
              <span>PEAK {String(Math.round(Math.max(...trace) * 100)).padStart(3, '0')}%</span>
            </div>
          </section>

          <aside className="lcars-status-panel">
            <div className="lcars-section-heading">
              <div>
                <span className="lcars-reactor-eyebrow">LIVE DIAGNOSTICS</span>
                <h2>Subsystems</h2>
              </div>
              <span className="lcars-status-count">{systems.filter((system) => system.on).length}<i> / {systems.length}</i></span>
            </div>

            <div className="lcars-system-list">
              {systems.map((system) => (
                <div className="lcars-system-row" key={system.name}>
                  <i className={`lcars-system-indicator tone-${system.tone}${system.on ? ' is-on' : ''}`} />
                  <span className="lcars-system-name">{system.name}</span>
                  <b title={system.state}>{system.state}</b>
                  {system.level !== undefined && <span className="lcars-system-meter"><i style={{ width: `${Math.max(3, system.level * 100)}%` }} /></span>}
                </div>
              ))}
            </div>

            <div className="lcars-link-section">
              <div className="lcars-link-heading">
                <span>NETWORK LINKS</span>
                <b>{String(connected.length).padStart(2, '0')}</b>
              </div>
              {connected.length > 0 ? (
                <div className="lcars-link-list">
                  {connected.slice(0, 4).map((name) => <span key={name}><i />{name}</span>)}
                  {connected.length > 4 && <span className="lcars-link-overflow">+{connected.length - 4} MORE LINKS</span>}
                </div>
              ) : (
                <div className="lcars-link-empty">No external links reported</div>
              )}
            </div>

            <div className="lcars-operation-strip">
              <span>ACTIVE PROCESS</span>
              <b title={activeTool ?? PHASE_LABELS[phase]}>{activeTool ?? PHASE_LABELS[phase]}</b>
            </div>
          </aside>
        </div>

        <section className="lcars-control-deck" aria-label="Computer controls">
          <header className="lcars-deck-heading">
            <span>COMMAND / OPERATIONS</span>
            {activeTool && <span className="lcars-deck-process" role="status" title={activeTool}>ACCESSING · {activeTool.replace(/[_-]/g, ' ')}</span>}
            <span className="lcars-deck-count">{turns.length.toString().padStart(2, '0')} ENTRIES</span>
          </header>
          <div className="lcars-deck-body">
            <div className="lcars-deck-operations">
              <div className="lcars-deck-actions" role="group" aria-label="Voice mode">
                <button type="button" aria-pressed={phase === 'listening' || phase === 'waking'} onClick={() => window.dispatchEvent(new Event('jarvis:listen'))} disabled={unavailable}><Mic size={18} /> Listen</button>
                <button type="button" aria-pressed={phase === 'dormant'} onClick={() => window.dispatchEvent(new Event('jarvis:standby'))} disabled={unavailable || phase === 'dormant'}><MicOff size={18} /> Standby</button>
              </div>
              {usingBridge && (
                <label className="lcars-provider">
                  <span>RESPONSE ENGINE</span>
                  <select aria-label="Provider" value={providers.selected} disabled={busy} onChange={(event) => selectProvider(event.target.value)}>
                    {providers.available.map((provider) => <option value={provider} key={provider}>{provider === 'claude' ? 'Claude' : provider === 'openai' ? 'OpenAI' : 'Local'}</option>)}
                  </select>
                </label>
              )}
              <div className="lcars-deck-switches">
                <button type="button" aria-pressed={ptt.enabled} onClick={() => window.dispatchEvent(new Event('jarvis:toggle-ptt'))} disabled={unavailable} title={ptt.enabled ? `Hold ${ptt.label} to speak` : 'Enable push-to-talk'}><AudioLines size={17} /> Push to talk <b>{ptt.enabled ? 'ON' : 'OFF'}</b></button>
                <button type="button" aria-pressed={gestures} onClick={() => window.dispatchEvent(new Event('jarvis:toggle-hands'))} disabled={unavailable} title="Toggle camera gesture tracking"><Camera size={17} /> Camera <b>{gestures ? 'ON' : 'OFF'}</b></button>
                <button type="button" aria-pressed={boardOpen} onClick={toggleBoard} disabled={!agentsSeen && !sessionAgents.length} title="Open agent board"><ClipboardList size={17} /> Agents <b>{sessionAgents.length}</b></button>
                <button type="button" onClick={() => window.dispatchEvent(new Event('jarvis:voice-profile'))} disabled={unavailable} title="Manage voice profile"><UserRound size={17} /> Voice profile <b>{enrolling ? 'OPEN' : 'SET'}</b></button>
                <button type="button" onClick={() => window.dispatchEvent(new Event('jarvis:toggle-diagnostics'))} title="Toggle voice diagnostics"><ShieldCheck size={17} /> Diagnostics</button>
              </div>
            </div>
            <section className="lcars-deck-history" aria-label="Recent conversation">
              <header><span>SESSION LOG</span><button type="button" onClick={() => clearScreen('transcript')} disabled={!turns.length} title="Clear conversation log" aria-label="Clear conversation log"><Trash2 size={16} /></button></header>
              <div className="lcars-deck-transcript" aria-live="polite">
                {turns.length ? turns.slice(-8).map((turn) => (
                  <article key={turn.id} className={`lcars-deck-turn lcars-deck-turn-${turn.role}`}>
                    <span>{turn.role === 'user' ? 'YOU' : 'COMPUTER'}</span>
                    <p>{turn.text || 'Responding...'}</p>
                  </article>
                )) : <p className="lcars-deck-empty">No exchanges yet.</p>}
              </div>
              {(caption || error) && <div className={`lcars-deck-feedback${error ? ' is-error' : ''}`} role="status">{error || caption}</div>}
              <AgentBoard />
              <Diagnostics inline />
            </section>
          </div>
          <form className="lcars-command-form" onSubmit={(event) => {
            event.preventDefault()
            if (!command.trim() || unavailable || busy) return
            window.dispatchEvent(new CustomEvent('jarvis:command', { detail: command.trim() }))
            setCommand('')
          }}>
            <input aria-label="Command" placeholder={unavailable ? 'Computer starting...' : 'Ask the computer'} value={command} onChange={(event) => setCommand(event.target.value)} disabled={unavailable || busy} autoComplete="off" />
            <button type="submit" disabled={!command.trim() || unavailable || busy} title="Send command"><Send size={18} /> Send</button>
          </form>
        </section>
      </main>
    </div>
  )
}
