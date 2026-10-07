import { useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../../../src/config'
import { usingBridge } from '../../../src/lib/brain'

/**
 * The status report: where the plan stands, in one page.
 *
 * It reads two ledgers, not one. PA memory holds the user's side — the focus,
 * the goals, the to-do list, the progress log. The loose-ends ledger holds the
 * computer's own unfinished work, and leaving it out made the report a
 * half-truth: it could claim a clear plan while an unpushed commit and an
 * unverified fix sat in a file nobody was reading. The two are fetched
 * independently so a missing ledger costs its own section and nothing more.
 */

type MemoryReport = {
  goals: string[]
  focus: string
  tasks: { text: string; added: string | null }[]
  progress: { date: string | null; text: string }[]
}

type LooseItem = {
  date: string | null
  project: string | null
  action: string
  state: string | null
  status: 'open' | 'partial' | 'done'
}

type Ledger = { items: LooseItem[]; open: number; missing: boolean }

/** Partial work first: something half-done is more urgent than something unstarted. */
const RANK: Record<LooseItem['status'], number> = { partial: 0, open: 1, done: 2 }
const LABEL: Record<LooseItem['status'], string> = { partial: 'PARTIAL', open: 'OPEN', done: 'CLEARED' }

/** Cleared items are history; the report is about what is still outstanding. */
const outstanding = (ledger: Ledger | null): LooseItem[] =>
  ledger && !ledger.missing
    ? [...ledger.items]
        .filter((item) => item.status !== 'done')
        .sort((a, b) => RANK[a.status] - RANK[b.status] || (b.date ?? '').localeCompare(a.date ?? ''))
    : []

function StatusReport({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<MemoryReport | null>(null)
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [error, setError] = useState('')
  const [ledgerError, setLedgerError] = useState('')
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
    // Separate on purpose: the ledger failing must not blank the whole report.
    fetch(`${BRIDGE_HTTP_URL}/memory/loose-ends`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('The ledger is unavailable')
        return response.json() as Promise<Ledger>
      })
      .then(setLedger)
      .catch(() => { if (!controller.signal.aborted) setLedgerError('Could not read the loose-ends ledger.') })
    return () => controller.abort()
  }, [])

  const loose = outstanding(ledger)

  return (
      <section className="lcars-report-window" role="region" aria-labelledby="lcars-report-title" onKeyDownCapture={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    }}>
        <header><div><span className="lcars-reactor-eyebrow">PERSONAL ASSISTANT / CURRENT PLAN</span><h2 id="lcars-report-title">Status report</h2></div></header>
        <p className="lcars-report-time">Generated {generatedAt}</p>
        {!usingBridge ? <p className="lcars-report-empty">The task list requires the local bridge.</p>
          : error ? <p className="lcars-report-empty" role="alert">{error}</p>
            : !report ? <p className="lcars-report-empty">Loading task list...</p>
              : <div className="lcars-report-content">
                <section><h3>Current focus</h3><p>{report.focus || 'No current focus recorded.'}</p></section>
                <section><h3>Goals</h3>{report.goals.length ? <ul>{report.goals.map((goal, index) => <li key={`${index}-${goal}`}>{goal}</li>)}</ul> : <p>No goals recorded.</p>}</section>
                <section><h3>To-do list <span>{report.tasks.length} open</span></h3>{report.tasks.length ? <ul>{report.tasks.map((task, index) => <li key={`${index}-${task.text}`}>{task.text}{task.added && <small>Since {task.added}</small>}</li>)}</ul> : <p>No open tasks.</p>}</section>
                <section><h3>Progress made</h3>{report.progress.length ? <ul>{report.progress.map((item, index) => <li key={`${index}-${item.text}`}>{item.text}{item.date && <small>{item.date}</small>}</li>)}</ul> : <p>No progress logged yet.</p>}</section>
                {/* The computer's own debt, kept distinct from the user's tasks. */}
                <section>
                  <h3>Loose ends <span>{loose.length} outstanding</span></h3>
                  {ledgerError ? <p role="alert">{ledgerError}</p>
                    : !ledger ? <p>Reading ledger...</p>
                      : !loose.length ? <p>Nothing outstanding. No incomplete work recorded.</p>
                        : <ul>
                          {loose.map((item, index) => (
                            <li key={`${index}-${item.action}`} data-status={item.status}>
                              {item.action}
                              <small>{[LABEL[item.status], item.project, item.state, item.date].filter(Boolean).join(' — ')}</small>
                            </li>
                          ))}
                        </ul>}
                </section>
                {/* What to do next reads from both ledgers: an unfinished thing
                    the computer owes outranks a task not yet begun. */}
                <section><h3>Next steps</h3>{loose.length || report.tasks.length
                  ? <ol>
                    {loose.slice(0, 2).map((item, index) => <li key={`loose-${index}`}>{item.action}<small>Loose end</small></li>)}
                    {report.tasks.slice(0, 3).map((task, index) => <li key={`task-${index}`}>{task.text}</li>)}
                  </ol>
                  : <p>Nothing pending. Add a task when you have a next step.</p>}</section>
              </div>}
      </section>
  )
}

export default StatusReport
