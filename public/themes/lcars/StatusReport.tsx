import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { BRIDGE_HTTP_URL } from '../../../src/config'
import { usingBridge } from '../../../src/lib/brain'

type MemoryReport = {
  goals: string[]
  focus: string
  tasks: { text: string; added: string | null }[]
  progress: { date: string | null; text: string }[]
}

function StatusReport({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [report, setReport] = useState<MemoryReport | null>(null)
  const [error, setError] = useState('')
  const [generatedAt] = useState(() => new Date().toLocaleString())

  useEffect(() => {
    if (!usingBridge) return
    const controller = new AbortController()
    fetch(`${BRIDGE_HTTP_URL}/memory/status`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Memory is unavailable')
        return response.json() as Promise<MemoryReport>
      })
      .then(setReport)
      .catch(() => { if (!controller.signal.aborted) setError('Could not load the task list.') })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => previousFocus?.focus()
  }, [])

  return createPortal(
    <div className="lcars-report-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} onKeyDownCapture={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key === 'Tab') { event.preventDefault(); closeRef.current?.focus() }
    }}>
      <section className="lcars-report-window" role="dialog" aria-modal="true" aria-labelledby="lcars-report-title">
        <header><div><span className="lcars-reactor-eyebrow">PERSONAL ASSISTANT / CURRENT PLAN</span><h2 id="lcars-report-title">Status report</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close status report" title="Close status report"><X size={16} /></button></header>
        <p className="lcars-report-time">Generated {generatedAt}</p>
        {!usingBridge ? <p className="lcars-report-empty">The task list requires the local bridge.</p>
          : error ? <p className="lcars-report-empty" role="alert">{error}</p>
            : !report ? <p className="lcars-report-empty">Loading task list...</p>
              : <div className="lcars-report-content">
                <section><h3>Current focus</h3><p>{report.focus || 'No current focus recorded.'}</p></section>
                <section><h3>Goals</h3>{report.goals.length ? <ul>{report.goals.map((goal, index) => <li key={`${index}-${goal}`}>{goal}</li>)}</ul> : <p>No goals recorded.</p>}</section>
                <section><h3>To-do list <span>{report.tasks.length} open</span></h3>{report.tasks.length ? <ul>{report.tasks.map((task, index) => <li key={`${index}-${task.text}`}>{task.text}{task.added && <small>Since {task.added}</small>}</li>)}</ul> : <p>No open tasks.</p>}</section>
                <section><h3>Progress made</h3>{report.progress.length ? <ul>{report.progress.map((item, index) => <li key={`${index}-${item.text}`}>{item.text}{item.date && <small>{item.date}</small>}</li>)}</ul> : <p>No progress logged yet.</p>}</section>
                <section><h3>Next steps</h3>{report.tasks.length ? <ol>{report.tasks.slice(0, 3).map((task, index) => <li key={`${index}-${task.text}`}>{task.text}</li>)}</ol> : <p>Nothing pending. Add a task when you have a next step.</p>}</section>
              </div>}
      </section>
    </div>,
    document.body,
  )
}

export default StatusReport
