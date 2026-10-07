import { useEffect, useId, useMemo, useState } from 'react'
import { Download, Eye, FileText, Play, RefreshCw, Send } from 'lucide-react'

import { useStore } from '../store'
import { decideApproval } from '../lib/brain'
import { goalRequest, reportRequest, type TaskReports } from '../lib/bridge'
import { ago, agentSummary, capacityLine, mainTaskRows, mergeBoard, statusLabel, type AgentBoardData, type BoardAgent } from '../lib/board'
import { reportDocumentHtml } from '../lib/report-document'

/**
 * The agent board: main tasks and their consolidated coordinator results.
 * Worker rows appear only where attention may be needed; other workers sit
 * beneath their goal until the user expands them.
 * The merged data still accounts for all workers and session subagents.
 *
 * It opens by itself while anything is working or waiting on the user, and on
 * the A key; with nothing happening it stays out of the way. Colours come from
 * the theme's accent so every theme styles it without its own rules.
 */

const KIND_LABEL: Record<BoardAgent['kind'], string> = {
  goal: 'goal',
  task: 'agent',
  subagent: 'agent',
}

/** Anything the user could still act on, and so a reason to open the board. */
const LIVE: BoardAgent['status'][] = ['running', 'awaiting_approval', 'blocked']

function AttentionReply({ goalId, name, paused, online }: { goalId: string; name: string; paused: boolean; online: boolean }) {
  const inputId = useId()
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  async function submit() {
    if (!online || busy || !info.trim()) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await goalRequest({ goalId, info: info.trim(), resume: paused })
      setInfo('')
      setNotice('Reply received. The coordinator will review the blocker; task progress appears above.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  return (
    <form className="ab-attention" aria-label={`Respond to ${name}`} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label htmlFor={inputId}>Information for this task</label>
      <textarea id={inputId} value={info} maxLength={10000} rows={3} disabled={busy} onChange={(event) => setInfo(event.target.value)} />
      <button type="submit" title={paused ? 'Send information and resume this goal' : 'Send information to the coordinator'} disabled={!online || busy || !info.trim()}>
        {paused ? <Play size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}{busy ? 'Sending...' : paused ? 'Send & Resume' : 'Send Reply'}
      </button>
      {!online && <p role="status">Background agents are offline.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </form>
  )
}

function ReportContent({ taskId, online }: { taskId: string; online: boolean }) {
  const [reports, setReports] = useState<TaskReports | null>(null)
  const [error, setError] = useState('')
  const [busyFile, setBusyFile] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    setReports(null)
    setError('')
    if (online) void reportRequest({ action: 'task', taskId }).then((data) => {
      if (!cancelled && 'files' in data) setReports(data)
    }).catch((err) => { if (!cancelled) setError(String(err.message ?? err)) })
    return () => { cancelled = true }
  }, [taskId, online, revision])

  async function readFile(file: string) {
    if (!online || busyFile) return null
    setBusyFile(file)
    setError('')
    try {
      const data = await reportRequest({ action: 'task', taskId, file })
      if (!('content' in data)) throw new Error('The selected document is unavailable.')
      return data.content
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
      return null
    } finally { setBusyFile('') }
  }

  async function viewFile(file: string) {
    const content = await readFile(file)
    if (content === null) return
    const title = file.split('/').pop() || file
    useStore.getState().pushBlade({
      id: `agent-document-${crypto.randomUUID()}`,
      title,
      kind: 'markup',
      html: reportDocumentHtml(file, content),
      size: 'wide',
      hold: 'sticky',
    })
  }

  async function downloadFile(file: string) {
    const content = await readFile(file)
    if (content === null) return
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.split('/').pop() || 'report.txt'
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="ab-reports">
      <button type="button" title="Refresh reports" aria-label="Refresh reports" disabled={!online} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} /></button>
      {!online && <p role="status">Background agents are offline.</p>}
      {error && <p role="alert">{error}</p>}
      {online && !reports && !error && <p role="status">Loading files...</p>}
      {reports && !reports.files.length && <p>No saved reports or files.</p>}
      {!!reports?.files.length && <ul className="ab-file-list" aria-label="Task reports and files">
        {reports.files.map((file) => (
          <li key={file}>
            <span><FileText size={15} aria-hidden="true" />{file}</span>
            <span className="ab-file-actions">
              <button type="button" title={`View ${file}`} disabled={Boolean(busyFile) || !online} onClick={() => void viewFile(file)}><Eye size={15} aria-hidden="true" />View</button>
              <button type="button" title={`Download ${file}`} disabled={Boolean(busyFile) || !online} onClick={() => void downloadFile(file)}><Download size={15} aria-hidden="true" />Download</button>
            </span>
          </li>
        ))}
      </ul>}
      {busyFile && <p role="status">Opening {busyFile}...</p>}
    </div>
  )
}

function SubagentResult({ task, online }: { task: BoardAgent; online: boolean }) {
  const [expanded, setExpanded] = useState(false)
  return <li className="ab-subagent">
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span className={`ab-chip ab-chip-${task.status}`}>{statusLabel(task.status)}</span>
        <span>{task.name}</span>
      </summary>
      {expanded && <>
        {task.result && <p className="ab-subagent-result">{task.result}</p>}
        {task.approval && <div className="ab-approval" role="group" aria-label={`Approval required: ${task.approval.action}`}>
          <span className="ab-ask">{task.approval.category} · {task.approval.action}</span>
          <code className="ab-approval-detail">{task.approval.detail}</code>
          <span className="ab-actions">
            <button type="button" onClick={() => decideApproval(task.approval!.id, 'approve')}>Approve</button>
            <button type="button" onClick={() => decideApproval(task.approval!.id, 'deny')}>Deny</button>
          </span>
        </div>}
        <ReportContent taskId={task.id} online={online} />
      </>}
    </details>
  </li>
}

function TaskResult({ row, tasks, online }: { row: BoardAgent; tasks: BoardAgent[]; online: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const children = tasks.filter((task) => task.status !== 'blocked' && !task.approval)
  return <section className="ab-main-result" aria-label={`Result for ${row.name}`}>
    <h3>Result</h3>
    <p>{row.result || (row.status === 'done' ? 'No consolidated result was saved.' : 'No consolidated result yet.')}</p>
    {!!children.length && <details className="ab-report-details ab-subagents" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><FileText size={16} aria-hidden="true" />Sub-agents · {children.length}</summary>
      {expanded && <ul>{children.map((task) => <SubagentResult key={task.id} task={task} online={online} />)}</ul>}
    </details>}
  </section>
}

function SessionSubagent({ row }: { row: BoardAgent }) {
  const [expanded, setExpanded] = useState(false)
  return <li className="ab-subagent"><details onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><span className={`ab-chip ab-chip-${row.status}`}>{statusLabel(row.status)}</span><span>{row.name}</span></summary>
    {expanded && <>
      <p className="ab-subagent-result">{row.result || row.activity}</p>
      {row.brief && <p className="ab-subagent-result">{row.brief}</p>}
    </>}
  </details></li>
}

export function AgentBoard() {
  const board = useStore((s) => s.agentBoard)
  const online = useStore((s) => s.agentsOnline)
  const seen = useStore((s) => s.agentsSeen)
  const open = useStore((s) => s.boardOpen)
  const exclusiveCommandWindows = useStore((s) => s.exclusiveCommandWindows)
  const session = useStore((s) => s.sessionAgents)
  const [view, setView] = useState<'current' | 'history'>('current')
  const [history, setHistory] = useState<AgentBoardData | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    if (view !== 'history' || !open || !online) return
    setLoading(true)
    setError('')
    void reportRequest({ action: 'history' }).then((data) => { if (!cancelled) setHistory(data) })
      .catch((err) => { if (!cancelled) setError(String(err.message ?? err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [view, open, online, revision])
  const source = view === 'history' ? history : board

  // The service being offline must not hide a subagent: a turn can dispatch one
  // with the agent service switched off entirely.
  const rows = useMemo(() => mergeBoard(source, session, { history: view === 'history' }), [source, session, view])
  const filtered = mainTaskRows(rows).filter((row) => `${row.name} ${row.goal ?? ''} ${row.kind === 'goal' ? row.result ?? '' : ''} ${row.status}`.toLowerCase().includes(query.trim().toLowerCase()))
  const sessionRows = view === 'current' ? rows.filter((row) => row.kind === 'subagent') : []
  const capacity = online ? (board?.capacity ?? null) : null
  const pool = capacityLine(capacity)

  // Subagents alone are reason enough to have a board.
  if (!seen && !session.length) return null
  if (exclusiveCommandWindows && !open) return null
  if (!open && !rows.some((r) => LIVE.includes(r.status))) return null

  return (
    <div className="agent-board" role="region" aria-label="Agent board">
      <div className="ab-head">
        JARVIS AGENTS{seen && !online && <span className="ab-offline"> · offline</span>}
        <span className="ab-summary"> · {agentSummary(rows)}</span>
      </div>
      <div className="ab-recall">
        <div role="tablist" aria-label="Agent work">
          <button type="button" role="tab" aria-selected={view === 'current'} onClick={() => setView('current')}>Current</button>
          <button type="button" role="tab" aria-selected={view === 'history'} onClick={() => setView('history')}>History</button>
        </div>
        {view === 'history' && <button type="button" title="Refresh history" aria-label="Refresh history" disabled={!online || loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} /></button>}
        <input type="search" aria-label="Search agent tasks and results" placeholder="Search tasks and results" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {view === 'history' && loading && <p role="status">Loading history...</p>}
      {view === 'history' && error && <p role="alert">{error}</p>}
      {/* Where the work can run, and how much of it is in use. One line, plus a
          chip per machine once there is more than one to choose between. */}
      {pool && (
        <div className="ab-pool">
          <span className="ab-pool-line">{pool}</span>
          {capacity && capacity.endpoints.length > 1 && (
            <span className="ab-eps">
              {capacity.endpoints.map((endpoint) => (
                <span
                  key={endpoint.id}
                  className="ab-ep"
                  data-down={endpoint.healthy ? undefined : ''}
                  title={`${endpoint.label}${endpoint.model ? ` · ${endpoint.model}` : ''} · ${endpoint.kind}${endpoint.healthy ? '' : ' · unreachable'}`}
                >
                  {endpoint.id} {endpoint.running}/{endpoint.concurrency}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      {seen && !online && <div className="ab-empty">The agent service is offline.</div>}
      {!filtered.length && !loading && <div className="ab-empty">{query ? 'No matching tasks or results.' : view === 'history' ? 'No saved task history.' : 'Nothing in progress.'}</div>}
      <ul className="ab-list">
        {filtered.map((row) => (
          <li key={`${row.kind}-${row.id}`} className="ab-row" data-kind={row.kind} data-nested={row.parentId ? '' : undefined}>
            <span className="ab-line">
              <span className={`ab-chip ab-chip-${row.status}`}>{statusLabel(row.status)}</span>
              <span className="ab-name">{row.name}</span>
              <span className="ab-kind">{KIND_LABEL[row.kind]}</span>
              {/* History outlives the session now, so a row has to say when. */}
              {view !== 'history' && ago(row.finishedAt ?? row.startedAt) && (
                <span className="ab-when">{ago(row.finishedAt ?? row.startedAt)}</span>
              )}
            </span>
            {view !== 'history' && row.progress !== null && (
              <span className="ab-bar">
                <span style={{ width: `${row.progress * 100}%` }} />
              </span>
            )}
            {view !== 'history' && row.kind === 'goal' && row.activity && <span className="ab-activity">{row.activity}</span>}
            {row.kind === 'goal' && <TaskResult row={row} tasks={rows.filter((task) => task.kind === 'task' && task.parentId === row.id)} online={online} />}
            {view !== 'history' && online && row.kind === 'task' && row.awaitingResponse && row.parentId && board?.goals.some((goal) => goal.id === row.parentId && ['active', 'paused'].includes(goal.status)) && (
              <AttentionReply key={row.id} goalId={row.parentId} name={row.name} paused={board.goals.find((goal) => goal.id === row.parentId)?.status === 'paused'} online={online} />
            )}
            {view !== 'history' && online && row.kind === 'goal' && row.status === 'paused' && row.awaitingResponse && (
              <AttentionReply key={row.id} goalId={row.id} name={row.name} paused online={online} />
            )}
            {row.approval && (
              <div className="ab-approval" role="group" aria-label={`Approval required: ${row.approval.action}`}>
                <div className="ab-approval-heading">
                  <span className="ab-ask">{row.approval.category} · {row.approval.action}</span>
                  {row.approval.created && <span className="ab-approval-age">Requested {ago(row.approval.created)}</span>}
                </div>
                <code className="ab-approval-detail">{row.approval.detail}</code>
                <span className="ab-actions">
                  <button type="button" onClick={() => decideApproval(row.approval!.id, 'approve')}>Approve</button>
                  <button type="button" onClick={() => decideApproval(row.approval!.id, 'deny')}>Deny</button>
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!!sessionRows.length && <details className="ab-report-details ab-session-agents">
        <summary>JARVIS session · {sessionRows.length} sub-agents</summary>
        <ul>{sessionRows.map((row) => <SessionSubagent key={row.id} row={row} />)}</ul>
      </details>}
    </div>
  )
}
