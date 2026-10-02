import { useEffect, useMemo, useState } from 'react'
import { copy } from '../../../src/theme'
import { mergeBoard, statusLabel } from '../../../src/lib/board'
import { decideApproval, providerState, selectProvider, usingBridge, watchProviders } from '../../../src/lib/brain'
import { useStore, type Phase } from '../../../src/store'
import { CharacterReactor } from '../../../src/ui/CharacterReactor'
import { OrinWave } from './Wave'

const MODES: { id: 'standby' | 'listening' | 'processing' | 'responding'; label: string }[] = [
  { id: 'standby', label: 'Standby' },
  { id: 'listening', label: 'Listen' },
  { id: 'processing', label: 'Process' },
  { id: 'responding', label: 'Respond' },
]

function modeFor(phase: Phase): (typeof MODES)[number]['id'] {
  if (phase === 'listening' || phase === 'waking') return 'listening'
  if (phase === 'thinking' || phase === 'tooling') return 'processing'
  if (phase === 'speaking') return 'responding'
  return 'standby'
}

function sendEvent(name: string) {
  window.dispatchEvent(new Event(name))
}

export function OrinHud() {
  const [now, setNow] = useState(() => new Date())
  const [draft, setDraft] = useState('')
  const [providers, setProviders] = useState(providerState)
  const phase = useStore((state) => state.phase)
  const caption = useStore((state) => state.caption)
  const turns = useStore((state) => state.turns)
  const connected = useStore((state) => state.connected)
  const board = useStore((state) => state.agentBoard)
  const agentsOnline = useStore((state) => state.agentsOnline)
  const agentsSeen = useStore((state) => state.agentsSeen)
  const sessionAgents = useStore((state) => state.sessionAgents)
  const error = useStore((state) => state.error)
  const ptt = useStore((state) => state.ptt)
  const clearScreen = useStore((state) => state.clearScreen)
  const agents = useMemo(
    () => mergeBoard(agentsOnline ? board : null, sessionAgents),
    [agentsOnline, board, sessionAgents],
  )
  const activeCount = agents.filter((agent) => agent.status === 'running').length
  const currentMode = modeFor(phase)
  const unavailable = phase === 'offline' || phase === 'boot'
  const lastAssistantTurn = [...turns].reverse().find((turn) => turn.role === 'jarvis')
  const headline = caption || lastAssistantTurn?.text || 'Awaiting your instruction.'

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => watchProviders((available, selected) => setProviders({ available, selected })), [])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const command = draft.trim()
    if (!command || unavailable) return
    window.dispatchEvent(new CustomEvent('jarvis:command', { detail: command }))
    setDraft('')
  }

  return (
    <>
      <CharacterReactor inline />
      <main className="orin-dashboard" aria-label="ORIN assistant console">
      <header className="orin-brand">
        <div className="orin-brand-line">
          <span className="orin-brand-light" />
          <h1>ORIN</h1>
        </div>
        <p>Operational Reasoning Interface</p>
      </header>

      <aside className="orin-left orin-column">
        <section className="orin-clock" aria-label="Local time and date">
          <time>{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time>
          <span>{now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        </section>

        <section className="orin-systems" aria-labelledby="orin-systems-title">
          <h2 id="orin-systems-title">Subsystems</h2>
          <div className="orin-system-row">
            <span><i className="orin-status-dot" />Core</span>
            <b>{unavailable ? 'OFFLINE' : 'NOMINAL'}</b>
          </div>
          <div className="orin-system-row">
            <span><i className="orin-status-dot" />Voice</span>
            <b>{phase === 'listening' ? 'ACTIVE' : unavailable ? 'OFFLINE' : 'READY'}</b>
          </div>
          {connected.map((system) => (
            <div className="orin-system-row" key={system}>
              <span><i className="orin-status-dot" />{system}</span>
              <b>ONLINE</b>
            </div>
          ))}
          {!connected.length && <p className="orin-muted">No external systems linked</p>}
        </section>

        <section className="orin-modes" aria-labelledby="orin-modes-title">
          <h2 id="orin-modes-title">Core state</h2>
          <div className="orin-mode-list">
            {MODES.map((mode) => {
              const active = mode.id === currentMode
              const actionable = mode.id === 'standby' || mode.id === 'listening'
              return (
                <button
                  type="button"
                  key={mode.id}
                  className={active ? 'is-active' : ''}
                  aria-pressed={active}
                  disabled={unavailable || !actionable}
                  title={actionable ? mode.label : 'This state is set automatically'}
                  onClick={() => sendEvent(mode.id === 'standby' ? 'jarvis:standby' : 'jarvis:listen')}
                >
                  {mode.label}
                </button>
              )
            })}
          </div>
        </section>
      </aside>

      <section className="orin-center orin-column" aria-label="Assistant interaction">
        <header className="orin-center-head">
          <div className="orin-phase" data-phase={phase}>
            <span className="orin-status-dot" />
            {copy.status[phase]}
          </div>
          {usingBridge && (
            <label className="orin-provider">
              <span>Provider</span>
              <select
                aria-label="Provider"
                value={providers.selected}
                disabled={phase === 'thinking' || phase === 'tooling' || phase === 'speaking'}
                onChange={(event) => selectProvider(event.target.value)}
              >
                {providers.available.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider === 'claude' ? 'Claude' : provider === 'openai' ? 'OpenAI' : 'Local'}
                  </option>
                ))}
              </select>
            </label>
          )}
        </header>
        {ptt.enabled && (
          <div className={`orin-ptt-indicator${ptt.held ? ' is-live' : ''}`} role="status">
            <span className="orin-status-dot" />
            <span>{ptt.held ? 'Mic live' : ptt.binding ? 'Set talk key' : 'Push to talk on'}</span>
            {!ptt.held && !ptt.binding && <small>Hold {ptt.label}</small>}
          </div>
        )}
        <OrinWave />
        <p className="orin-utterance" aria-live="polite">{headline}</p>
        <form className="orin-command" onSubmit={submit}>
          <label className="orin-sr-only" htmlFor="orin-command-input">Command</label>
          <input
            id="orin-command-input"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={unavailable ? 'Initialize ORIN to send a command' : 'Speak or type a command'}
            autoComplete="off"
            disabled={unavailable}
          />
          <button className="orin-listen" type="button" aria-label="Start listening" title="Start listening" disabled={unavailable} onClick={() => sendEvent('jarvis:listen')}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
          <button className="orin-send" type="submit" aria-label="Send command" title="Send command" disabled={unavailable || !draft.trim()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </form>
        {error && <p className="orin-error" role="alert">{error}</p>}
      </section>

      <aside className="orin-right orin-column">
        <section className="orin-agents">
          <header className="orin-section-head">
            <h2>Agents</h2>
            <span>{activeCount} active</span>
          </header>
          <div className="orin-scroll-list">
            {agents.length === 0 ? (
              <p className="orin-empty">{agentsOnline ? 'No agents in progress.' : agentsSeen ? 'Agent service offline.' : 'Agent service not connected.'}</p>
            ) : agents.slice(0, 8).map((agent) => (
              <article className="orin-agent" data-status={agent.status} key={`${agent.kind}-${agent.id}`}>
                <div className="orin-agent-top">
                  <span className="orin-agent-name">{agent.name}</span>
                  <span className="orin-agent-status">{statusLabel(agent.status)}</span>
                </div>
                <p>{agent.activity}</p>
                {agent.progress !== null && <div className="orin-progress"><i style={{ width: `${Math.round(agent.progress * 100)}%` }} /></div>}
                {agent.approval && (
                  <div className="orin-approval">
                    <span>{agent.approval.action}</span>
                    <button type="button" onClick={() => decideApproval(agent.approval!.id, 'approve')}>Approve</button>
                    <button type="button" onClick={() => decideApproval(agent.approval!.id, 'deny')}>Deny</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="orin-session">
          <header className="orin-section-head">
            <h2>Session log</h2>
            <div className="orin-session-actions">
              <span>{turns.length} entries</span>
              <button type="button" disabled={!turns.length} onClick={() => clearScreen('transcript')}>Clear</button>
            </div>
          </header>
          <div className="orin-scroll-list orin-log-list" aria-live="polite">
            {turns.length === 0 ? <p className="orin-empty">No exchanges yet.</p> : turns.slice(-8).map((turn) => (
              <article className={`orin-log-entry orin-log-${turn.role}`} key={turn.id}>
                <header><span>{turn.role === 'user' ? 'YOU' : 'ORIN'}</span><span>{turn.tools?.length ? `${turn.tools.length} tools` : ''}</span></header>
                <p>{turn.text || (turn.role === 'jarvis' ? 'Responding…' : '')}</p>
              </article>
            ))}
          </div>
        </section>
      </aside>
      </main>
    </>
  )
}