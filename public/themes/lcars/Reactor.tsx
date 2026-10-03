import { useEffect, useId, useRef, useState } from 'react'
import { Activity, AudioLines, Camera, ClipboardList, FileText, Mic, MicOff, Search, Send, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import { providerState, selectProvider, selectModel, usingBridge, watchProviders } from '../../../src/lib/brain'
import { useStore, type Phase } from '../../../src/store'
import { AgentBoard } from '../../../src/ui/AgentBoard'
import { CommandPalette } from '../../../src/ui/CommandPalette'
import { Timeline } from '../../../src/ui/Timeline'
import { Diagnostics } from '../../../src/ui/Diagnostics'
import StatusReport from './StatusReport'

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
const selectControl = (control: HTMLElement) => {
  document.querySelectorAll('[data-lcars-selected]').forEach((selected) => selected.removeAttribute('data-lcars-selected'))
  control.setAttribute('data-lcars-selected', 'true')
}

const WAVE_LAYERS = [
  { className: 'lcars-wave-line-violet', particleClass: 'lcars-wave-particle-violet', phase: 0, gain: 0.82, speed: 3.1 },
  { className: 'lcars-wave-line-cyan', particleClass: 'lcars-wave-particle-cyan', phase: 1.8, gain: 0.66, speed: 4.6 },
  { className: 'lcars-wave-line-orange', particleClass: 'lcars-wave-particle-orange', phase: 3.6, gain: 0.54, speed: 6.2 },
]

export function Reactor({ inline = false }: { inline?: boolean } = {}) {
  const gridGradientId = useId().replace(/:/g, '')
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
  const timelineOpen = useStore((state) => state.timelineOpen)
  const toggleTimeline = useStore((state) => state.toggleTimeline)
  const toolCalls = useStore((state) => state.toolEvents.length)
  const clearScreen = useStore((state) => state.clearScreen)
  const reactor = useStore((state) => state.ui.reactor)
  const [trace, setTrace] = useState<number[]>(() => Array(TRACE_SAMPLES).fill(0))
  const [command, setCommand] = useState('')
  const [providers, setProviders] = useState(providerState)
  const commandWindow = useStore((state) => state.commandWindow)
  const setCommandWindow = useStore((state) => state.setCommandWindow)
  const statusReportOpen = commandWindow === 'status'
  const diagnosticsOpen = commandWindow === 'diagnostics'
  const commandPaletteOpen = commandWindow === 'palette'
  const levelRef = useRef(level)
  const gridLevelRef = useRef(level)
  levelRef.current = level

  useEffect(() => {
    const state = useStore.getState()
    state.setCommandWindow(state.enrolling ? 'voice' : state.timelineOpen ? 'timeline' : state.boardOpen ? 'agents' : null)
    useStore.setState({ exclusiveCommandWindows: true })
    return () => { useStore.setState({ exclusiveCommandWindows: false }) }
  }, [])

  useEffect(() => {
    const select = (event: Event) => {
      if (!(event.target instanceof Element)) return
      const control = event.target.closest<HTMLElement>('button, select')
      if (!control || control.matches(':disabled') || document.documentElement.dataset.theme !== 'lcars') return
      selectControl(control)
    }
    document.addEventListener('click', select, true)
    document.addEventListener('change', select, true)
    return () => {
      document.removeEventListener('click', select, true)
      document.removeEventListener('change', select, true)
      document.querySelectorAll('[data-lcars-selected]').forEach((selected) => selected.removeAttribute('data-lcars-selected'))
    }
  }, [])

  useEffect(() => {
    if (!commandWindow) return
    const control = document.querySelector<HTMLElement>(`[data-command-window="${commandWindow}"]`)
    if (control) selectControl(control)
  }, [commandWindow])

  useEffect(() => {
    const id = window.setInterval(() => {
      setTrace((samples) => [...samples.slice(1), levelRef.current])
    }, 50)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let frame = 0
    let previousTime = performance.now()
    const smoothGridLevel = (time: number) => {
      const elapsed = Math.min((time - previousTime) / 1000, 0.1)
      previousTime = time
      const response = 1 - Math.exp(-elapsed / 0.35)
      gridLevelRef.current += (levelRef.current - gridLevelRef.current) * response
      frame = window.requestAnimationFrame(smoothGridLevel)
    }
    frame = window.requestAnimationFrame(smoothGridLevel)
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => watchProviders(() => setProviders(providerState())), [])

  const className = 'character-reactor lcars-reactor'
  const style = {
    '--reactor-scale': reactor.scale,
    opacity: reactor.visible ? reactor.intensity : 0,
  } as React.CSSProperties
  const boundedLevel = Math.max(0, Math.min(1, level))
  const gridLevel = Math.max(0, Math.min(1, gridLevelRef.current))
  const unavailable = phase === 'offline' || phase === 'boot'
  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'
  const waveTime = performance.now() * 0.001
  const gridCenterX = 240
  const gridCenterY = 68
  const gridFlow = (waveTime * (0.08 + gridLevel * 0.05)) % 1
  const gridGradientOffset = (waveTime * (12 + gridLevel * 12)) % 240
  const gridPoint = (radius: number, angle: number) => ({
    x: gridCenterX + Math.cos(angle) * radius * 265,
    y: gridCenterY + Math.sin(angle) * radius * 104 + Math.max(0, 1 - radius) ** 2 * 38,
  })
  const gridPath = (points: { x: number; y: number }[]) => points
    .map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`)
    .join(' ')
  const gridRings = Array.from({ length: 7 }, (_, ringIndex) => {
    const ringProgress = ((ringIndex + 1) / 7 - gridFlow + 1) % 1
    const radius = 0.06 + ringProgress * 1.25
    const points = Array.from({ length: 65 }, (_, pointIndex) => gridPoint(radius, (pointIndex / 64) * Math.PI * 2))
    return gridPath(points)
  })
  const gridSpokes = Array.from({ length: 28 }, (_, spokeIndex) => {
    const angle = (spokeIndex / 28) * Math.PI * 2
    const points = Array.from({ length: 20 }, (_, pointIndex) => gridPoint(0.015 + (pointIndex / 19) * 1.22, angle))
    return gridPath(points)
  })
  const buildWavePath = (phase: number, gain: number, speed: number, timeOffset = 0) => trace.map((sample, index) => {
    const x = (index / (TRACE_SAMPLES - 1)) * 480
    const input = Math.max(0, Math.min(1, sample))
    const amplitude = (22 + boundedLevel * 25 + input * 10) * gain
    const angle = index * (0.76 + gain * 0.16) + phase + (waveTime + timeOffset) * speed
    const wave = Math.sin(angle) + Math.sin(angle * 0.47 + phase) * 0.34 + Math.sin(angle * 0.19 - phase) * 0.18
    const y = 75 - wave * amplitude
    return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
  }).join(' ')
  const wavePaths = WAVE_LAYERS.map(({ className, phase, gain, speed }) => ({
    className,
    path: buildWavePath(phase, gain, speed),
    nearTrail: buildWavePath(phase, gain, speed, -0.12),
    farTrail: buildWavePath(phase, gain, speed, -0.26),
  }))
  const waveParticles = Array.from({ length: 18 }, (_, index) => {
    const layer = WAVE_LAYERS[index % WAVE_LAYERS.length]
    const x = (waveTime * (34 + (index % 5) * 13) + index * 61) % 480
    const samplePosition = (x / 480) * (TRACE_SAMPLES - 1)
    const sample = trace[Math.floor(samplePosition)] ?? 0
    const input = Math.max(0, Math.min(1, sample))
    const amplitude = (22 + boundedLevel * 25 + input * 10) * layer.gain
    const angle = samplePosition * (0.76 + layer.gain * 0.16) + layer.phase + waveTime * layer.speed
    const wave = Math.sin(angle) + Math.sin(angle * 0.47 + layer.phase) * 0.34 + Math.sin(angle * 0.19 - layer.phase) * 0.18
    return { x, y: 75 - wave * amplitude, radius: index % 4 === 0 ? 2.1 : 1.25, className: layer.particleClass }
  })

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
              <svg className="lcars-wave" viewBox="0 0 480 150" preserveAspectRatio="none" role="presentation">
                <defs>
                  <linearGradient id={gridGradientId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="240" y2="0" spreadMethod="repeat" gradientTransform={`translate(${-gridGradientOffset} 0)`}>
                    <stop offset="0%" stopColor="#35eaff" />
                    <stop offset="27%" stopColor="#168bff" />
                    <stop offset="54%" stopColor="#a568ff" />
                    <stop offset="80%" stopColor="#1abaff" />
                    <stop offset="100%" stopColor="#35eaff" />
                  </linearGradient>
                </defs>
                <g className="lcars-wave-warp-grid" style={{ stroke: `url(#${gridGradientId})` }}>
                  {gridRings.map((path, index) => <path className="lcars-wave-grid-ring" d={path} key={`ring-${index}`} />)}
                  {gridSpokes.map((path, index) => <path className="lcars-wave-grid-spoke" d={path} key={`spoke-${index}`} />)}
                </g>
                <g className="lcars-wave-trails">
                  {wavePaths.map(({ className, farTrail, nearTrail }) => (
                    <g key={className}>
                      <path className={`lcars-wave-line ${className} lcars-wave-trail-far`} d={farTrail} />
                      <path className={`lcars-wave-line ${className} lcars-wave-trail-near`} d={nearTrail} />
                    </g>
                  ))}
                </g>
                {wavePaths.map(({ className, path }) => <path className={`lcars-wave-line ${className}`} d={path} key={className} />)}
                <g className="lcars-wave-particles">
                  {waveParticles.map(({ className, radius, x, y }, index) => (
                    <g className={className} key={index}>
                      <circle className="lcars-wave-particle-glow" cx={x} cy={y} r={radius * 2.8} />
                      <circle className="lcars-wave-particle-core" cx={x} cy={y} r={radius} />
                    </g>
                  ))}
                </g>
              </svg>
            </div>
            <div className="lcars-chart-axis">
              <span>-3 SEC</span><span>LIVE INPUT</span><span>NOW</span>
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
                <button type="button" data-function-error={Boolean(error)} aria-pressed={phase === 'listening' || phase === 'waking'} onClick={() => window.dispatchEvent(new Event('jarvis:listen'))} disabled={unavailable}><Mic size={18} /> Listen</button>
                <button type="button" aria-pressed={phase === 'dormant'} onClick={() => window.dispatchEvent(new Event('jarvis:standby'))} disabled={unavailable || phase === 'dormant'}><MicOff size={18} /> Standby</button>
              </div>
              {usingBridge && (
                <div className="lcars-deck-selects">
                  <label className="lcars-provider">
                    <span>RESPONSE ENGINE</span>
                    <select aria-label="Provider" value={providers.selected} disabled={busy} onChange={(event) => selectProvider(event.target.value)}>
                      {providers.available.map((provider) => <option value={provider} key={provider}>{provider === 'claude' ? 'Claude' : provider === 'openai' ? 'OpenAI' : 'Local'}</option>)}
                    </select>
                  </label>
                  {providers.models.length > 0 && (
                    <label className="lcars-provider">
                      <span>MODEL</span>
                      <select aria-label="Model" value={providers.model} disabled={busy || providers.models.length < 2} onChange={(event) => selectModel(event.target.value)}>
                        {providers.models.map((model) => <option value={model} key={model}>{model}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )}
              <div className="lcars-deck-switches">
                <button type="button" data-function-off={!ptt.enabled} data-function-active={ptt.enabled && ptt.held} aria-pressed={ptt.enabled} onClick={() => window.dispatchEvent(new Event('jarvis:toggle-ptt'))} disabled={unavailable} title={ptt.enabled ? `Hold ${ptt.label} to speak` : 'Enable push-to-talk'}><AudioLines size={17} /> Push to talk <b>{ptt.enabled ? 'ON' : 'OFF'}</b></button>
                <button type="button" data-function-off={!gestures} aria-pressed={gestures} onClick={() => window.dispatchEvent(new Event('jarvis:toggle-hands'))} disabled={unavailable} title="Toggle camera gesture tracking"><Camera size={17} /> Camera <b>{gestures ? 'ON' : 'OFF'}</b></button>
                <button type="button" data-command-window="agents" aria-pressed={boardOpen} onClick={toggleBoard} disabled={!agentsSeen && !sessionAgents.length} title="Open agent board"><ClipboardList size={17} /> Agents <b>{sessionAgents.length}</b></button>
                <button type="button" data-command-window="voice" aria-pressed={enrolling} onClick={() => window.dispatchEvent(new Event('jarvis:voice-profile'))} disabled={unavailable} title="Manage voice profile"><UserRound size={17} /> Voice profile <b>{enrolling ? 'OPEN' : 'SET'}</b></button>
                <button type="button" data-command-window="diagnostics" aria-pressed={diagnosticsOpen} onClick={() => window.dispatchEvent(new Event('jarvis:toggle-diagnostics'))} title="Toggle voice diagnostics"><ShieldCheck size={17} /> Diagnostics</button>
                <button type="button" data-command-window="status" aria-pressed={statusReportOpen} onClick={() => setCommandWindow(statusReportOpen ? null : 'status')} title="Open status report"><FileText size={17} /> Status report</button>
                <button type="button" data-command-window="palette" aria-pressed={commandPaletteOpen} onClick={() => window.dispatchEvent(new Event('jarvis:toggle-command-palette'))} title="Toggle command palette"><Search size={17} /> Command palette</button>
                <button type="button" data-command-window="timeline" aria-pressed={timelineOpen} onClick={toggleTimeline} title="Show what tools have run and for how long"><Activity size={17} /> Tool timeline <b>{toolCalls}</b></button>
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
              <CommandPalette inline />
              <Timeline inline />
              <Diagnostics inline />
              {statusReportOpen && <StatusReport onClose={() => setCommandWindow(null)} />}
            </section>
          </div>
          <form className="lcars-command-form" onSubmit={(event) => {
            event.preventDefault()
            if (!command.trim() || unavailable || busy) return
            window.dispatchEvent(new CustomEvent('jarvis:command', { detail: command.trim() }))
            setCommand('')
          }}>
            <input aria-label="Command" placeholder={unavailable ? 'Computer starting...' : 'Ask the computer'} value={command} onChange={(event) => setCommand(event.target.value)} disabled={unavailable || busy} autoComplete="off" />
            <button type="submit" data-function-error={Boolean(error)} disabled={!command.trim() || unavailable || busy} title="Send command"><Send size={18} /> Send</button>
          </form>
        </section>
      </main>
    </div>
  )
}
