import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'

type Command = { id: string; label: string; detail: string; keywords: string; run: () => void }

export function CommandPalette({ inline = false }: { inline?: boolean } = {}) {
  const [localOpen, setLocalOpen] = useState(false)
  const commandWindow = useStore((state) => state.commandWindow)
  const open = inline ? commandWindow === 'palette' : localOpen
  const setOpen = useCallback((value: boolean | ((current: boolean) => boolean)) => {
    if (!inline) { setLocalOpen(value); return }
    const state = useStore.getState()
    const next = typeof value === 'function' ? value(state.commandWindow === 'palette') : value
    if (next) state.setCommandWindow('palette')
    else if (state.commandWindow === 'palette') state.setCommandWindow(null)
  }, [inline])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const commands = useMemo<Command[]>(() => [
    { id: 'standby', label: 'Enter standby', detail: 'Stop the current response and return to standby', keywords: 'escape stop sleep', run: () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) },
    { id: 'listen', label: 'Start listening', detail: 'Open the microphone for a command', keywords: 'space talk microphone', run: () => window.dispatchEvent(new CustomEvent('jarvis:listen')) },
    { id: 'ptt', label: 'Toggle push to talk', detail: 'Enable or disable push-to-talk', keywords: 'mic keyboard k', run: () => window.dispatchEvent(new CustomEvent('jarvis:toggle-ptt')) },
    { id: 'agents', label: 'Toggle agent board', detail: 'Show or hide agent tasks and progress', keywords: 'tasks workers a', run: () => useStore.getState().toggleBoard() },
    { id: 'scheduler', label: 'Open task scheduler', detail: 'Manage timed and recurring background work', keywords: 'schedule calendar recurring timer tasks', run: () => useStore.getState().setCommandWindow('scheduler') },
    { id: 'timeline', label: 'Toggle tool timeline', detail: 'Show what tools have run and for how long', keywords: 'tools activity history duration shift t', run: () => useStore.getState().toggleTimeline() },
    { id: 'history', label: 'Toggle session history', detail: 'Review past chat sessions and their transcripts', keywords: 'sessions conversations transcript log chat history shift h', run: () => useStore.getState().toggleHistory() },
    { id: 'new-session', label: 'New session', detail: 'Save the current conversation and start a fresh one', keywords: 'new conversation fresh chat reset', run: () => window.dispatchEvent(new Event('jarvis:new-session')) },
    { id: 'hands', label: 'Toggle hand controls', detail: 'Enable or disable camera-based gestures', keywords: 'camera gestures g', run: () => window.dispatchEvent(new CustomEvent('jarvis:toggle-hands')) },
    { id: 'voice-profile', label: 'Open voice profile', detail: 'Enroll, re-record, or remove the voice profile', keywords: 'privacy voice p', run: () => window.dispatchEvent(new CustomEvent('jarvis:voice-profile')) },
    { id: 'diagnostics', label: 'Toggle diagnostics', detail: 'Show voice input and audio output diagnostics', keywords: 'debug d', run: () => window.dispatchEvent(new CustomEvent('jarvis:toggle-diagnostics')) },
    { id: 'clear-screen', label: 'Clear display', detail: 'Remove blades and panels from the screen', keywords: 'clear panels blades', run: () => useStore.getState().clearScreen('all') },
    { id: 'reset-interface', label: 'Reset interface', detail: 'Restore the default interface appearance', keywords: 'theme colours chrome', run: () => useStore.getState().resetUi() },
  ], [])
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return commands.map((command) => {
      const haystack = `${command.label} ${command.detail} ${command.keywords}`.toLowerCase()
      const score = terms.reduce((sum, term) => sum + (command.label.toLowerCase().includes(term) ? 4 : command.keywords.includes(term) ? 2 : haystack.includes(term) ? 1 : -100), 0)
      return { command, score }
    }).filter((entry) => entry.score >= 0).sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label)).map(({ command }) => command)
  }, [commands, query])

  useEffect(() => {
    const toggle = () => setOpen((value) => !value)
    const onKey = (event: KeyboardEvent) => {
      // Use Shift+Space: unlike Ctrl/Command+K, it does not conflict with browser search.
      if (event.code === 'Space' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        setOpen((value) => !value)
        return
      }
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('jarvis:toggle-command-palette', toggle)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('jarvis:toggle-command-palette', toggle)
    }
  }, [open, setOpen])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      requestAnimationFrame(() => input.current?.focus())
    }
  }, [open])

  useEffect(() => setActive(0), [query])

  if (!open) return null
  const run = (index: number) => {
    const command = results[index]
    if (!command) return
    setOpen(false)
    command.run()
  }

  const palette = (
      <section className={`command-palette${inline ? ' command-palette-inline' : ''}`} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : true} aria-label="Command palette">
        {inline && <header className="command-head">COMMAND PALETTE</header>}
        <div className="command-search"><span aria-hidden="true">⌕</span><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, results.length - 1)) }
          if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)) }
          if (event.key === 'Enter') { event.preventDefault(); run(active) }
        }} placeholder="Search commands…" aria-label="Search commands" aria-controls="command-results" aria-activedescendant={results[active] ? `command-${results[active].id}` : undefined} /><kbd>ESC</kbd></div>
        <div id="command-results" className="command-results" role="listbox" aria-label="Commands">
          {results.length ? results.map((command, index) => <button id={`command-${command.id}`} key={command.id} type="button" role="option" aria-selected={active === index} className={`command-option${active === index ? ' is-active' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => run(index)}><span><strong>{command.label}</strong><small>{command.detail}</small></span><kbd>↵</kbd></button>) : <div className="command-empty">No matching commands.</div>}
        </div>
        <footer className="command-foot"><span>↑↓ navigate</span><span>↵ run</span><span>⇧ Space toggle</span></footer>
      </section>
  )
  return inline ? palette : (
    <div className="command-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
      {palette}
    </div>
  )
}
