import { useEffect, useId, useMemo, useState } from 'react'
import { ArrowUpRight, Download, Eye, FileText, Pause, Pencil, Play, Plus, RefreshCw, Save, Send, Trash2 } from 'lucide-react'

import { useStore } from '../store'
import { decideApproval } from '../lib/brain'
import { decisionRequest, goalControlRequest, goalDecisionRequest, goalRequest, profileRequest, reportRequest, scheduleRequest, type TaskReports } from '../lib/bridge'
import { ago, agentSummary, capacityLine, deleteBlockReason, mainTaskRows, mergeBoard, mergeBoardData, stateGroup, statusLabel, type AgentBoardData, type AgentDecisionQuestion, type AgentProfile, type AgentProfileInput, type AgentReference, type BoardAgent, type InstalledSkill } from '../lib/board'
import { reportDocumentHtml } from '../lib/report-document'
import { localDateTime, onceFromLocal, type ScheduleTrigger } from '../lib/schedules'

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

/** Collect information from the user and send it to a blocked goal. */
function AttentionReply({ goalId, name, paused, online }: { goalId: string; name: string; paused: boolean; online: boolean }) {
  const inputId = useId()
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** Validate the reply locally, send it, and expose success or failure state. */
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
    <form className="ab-attention" aria-label={`Respond to ${name}`} onSubmit={(event) => {
      // Keep submission in the single-page flow and let the handler own feedback.
      event.preventDefault()
      void submit()
    }}>
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

/** Load a task's saved report list and open or download a selected file. */
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
      // Ignore results from an effect that was cleaned up or replaced.
      if (!cancelled && 'files' in data) setReports(data)
    }).catch((err) => {
      // Show request failures only while this task view is still mounted.
      if (!cancelled) setError(String(err.message ?? err))
    })
    return () => { cancelled = true }
  }, [taskId, online, revision])

  /** Fetch one report file and surface request errors in the detail pane. */
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

  /** Render a fetched report as a persistent reading blade. */
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

  /** Download a fetched report as a plain-text browser file. */
  async function downloadFile(file: string) {
    const content = await readFile(file)
    if (content === null) return
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.split('/').pop() || 'report.txt'
    anchor.click()
    // Release the temporary browser URL after the download has started.
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

/** Display the coordinator's consolidated result for a goal or task. */
function TaskResult({ row }: { row: BoardAgent }) {
  return <section className="ab-main-result" aria-label={`Result for ${row.name}`}>
    <h3>Result</h3>
    <p>{row.result || (row.status === 'done' ? 'No consolidated result was saved.' : 'No consolidated result yet.')}</p>
  </section>
}

/** Choose a safe, compact source label for a referenced document. */
const referenceSource = (reference: AgentReference) => {
  if (reference.path) return reference.path
  try { return reference.url ? new URL(reference.url).hostname : '' }
  catch { return reference.url ?? '' }
}

/** Collect and submit answers for a task's structured blocker questions. */
function DecisionForm({ task, goalId, online }: { task: BoardAgent; goalId: string; online: boolean }) {
  const noteId = useId()
  const relatedTasks = useMemo(() => [task], [task])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const questions = task.questions ?? []
  const complete = questions.length > 0 && questions.every((question) => answers[question.id])
  /** Send complete answers and optional notes once, then lock the form. */
  async function submit() {
    if (!online || busy || !complete) return
    setBusy(true)
    setError('')
    try {
      await decisionRequest({ goalId, taskId: task.id, answers, note: note.trim() || undefined })
      setSent(true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return <section className="ab-decision" aria-label="Agent decision">
    <GoalRelatedData tasks={relatedTasks} online={online} />
    {questions.map((question: AgentDecisionQuestion) => <fieldset key={question.id}>
      <legend>{question.prompt}</legend>
      {question.options.map((option) => <label key={option.id} className="ab-option">
        <input type="radio" name={`${task.id}-${question.id}`} value={option.id} checked={answers[question.id] === option.id} disabled={!online || busy || sent} onChange={() => setAnswers((previous) => ({ ...previous, [question.id]: option.id }))} />
        <span><strong>{option.label}</strong>{option.recommended && <em>Recommended</em>}{option.detail && <small>{option.detail}</small>}</span>
      </label>)}
    </fieldset>)}
    <label className="ab-decision-note" htmlFor={noteId}>Note to the agent <span>(optional)</span><textarea id={noteId} value={note} maxLength={2000} rows={3} disabled={!online || busy || sent} onChange={(event) => setNote(event.target.value)} /></label>
    {sent ? <p role="status">Decision sent.</p> : <button type="button" disabled={!online || busy || !complete} onClick={() => void submit()}><Send size={15} aria-hidden="true" />{busy ? 'Sending...' : 'Send decision'}</button>}
    {!online && <p role="status">Background agents are offline.</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}

/** Submit an explicit approval or rejection for a proposed goal plan. */
function GoalDecisionForm({ goalId, tasks, online }: { goalId: string; tasks: BoardAgent[]; online: boolean }) {
  const noteId = useId()
  const [decision, setDecision] = useState<'approve' | 'not_approve' | ''>('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  /** Send the selected goal decision and optional note to the bridge. */
  async function submit() {
    if (!online || busy || !decision) return
    setBusy(true)
    setError('')
    try {
      await goalDecisionRequest({ goalId, decision, note: note.trim() || undefined })
      setSent(true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return <section className="ab-decision" aria-label="Approve proposed plan">
    <GoalRelatedData tasks={tasks} online={online} />
    <fieldset>
      <legend>Approve this plan?</legend>
      <label className="ab-option"><input type="radio" name={`${goalId}-approval`} checked={decision === 'approve'} disabled={!online || busy || sent} onChange={() => setDecision('approve')} /><span><strong>Approve</strong><small>Resume within the agreed scope.</small></span></label>
      <label className="ab-option"><input type="radio" name={`${goalId}-approval`} checked={decision === 'not_approve'} disabled={!online || busy || sent} onChange={() => setDecision('not_approve')} /><span><strong>Do not approve</strong><small>Keep work paused and request a revision.</small></span></label>
    </fieldset>
    <label className="ab-decision-note" htmlFor={noteId}>Note to the agent <span>(optional)</span><textarea id={noteId} value={note} maxLength={2000} rows={3} disabled={!online || busy || sent} onChange={(event) => setNote(event.target.value)} /></label>
    {sent ? <p role="status">Decision sent.</p> : <button type="button" disabled={!online || busy || !decision} onClick={() => void submit()}><Send size={15} aria-hidden="true" />{busy ? 'Sending...' : 'Send decision'}</button>}
    {!online && <p role="status">Background agents are offline.</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}

/** List task references and open safe web links or retrieved local documents. */
function ReferenceList({ taskId, references, online }: { taskId: string; references: AgentReference[]; online: boolean }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState('')
  /** Validate and open a reference URL or fetch its stored document body. */
  async function open(reference: AgentReference, index: number) {
    if (!online || busy !== null) return
    setError('')
    if (reference.url) {
      try {
        const url = new URL(reference.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('This link is not supported.')
        useStore.getState().pushBlade({ id: `agent-reference-${crypto.randomUUID()}`, title: reference.title, kind: 'article', url: url.href, mode: 'reader', size: 'wide', hold: 'sticky' })
      } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
      return
    }
    setBusy(index)
    try {
      const data = await reportRequest({ action: 'reference', taskId, index })
      useStore.getState().pushBlade({
        id: `agent-reference-${crypto.randomUUID()}`,
        title: data.file,
        kind: 'markup',
        html: reportDocumentHtml(data.file, data.content),
        size: 'wide',
        hold: 'sticky',
      })
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(null) }
  }
  return <section className="ab-reference-section" aria-label="Referenced documents">
    <h3>Related data</h3>
    <ul className="ab-reference-list">{references.map((reference, index) => <li key={`${reference.url ?? reference.path}-${index}`}>
      <button className="ab-related-card" type="button" disabled={!online || busy !== null} onClick={() => void open(reference, index)} title={`Open ${reference.title}`}>
        <span className="ab-related-icon"><FileText size={16} aria-hidden="true" /></span>
        <span className="ab-related-copy"><strong>{busy === index ? 'Opening...' : reference.title}</strong><small>{referenceSource(reference)}</small></span>
        <span className="ab-related-open" aria-hidden="true">↗</span>
      </button>
    </li>)}</ul>
    {error && <p role="alert">{error}</p>}
  </section>
}

type RelatedItem =
  | { kind: 'file'; key: string; taskId: string; taskName: string; file: string; title: string; meta: string }
  | { kind: 'reference'; key: string; taskId: string; taskName: string; reference: AgentReference; referenceIndex: number; title: string; meta: string }

/** Combine task references and saved files into one goal-level related-data list. */
function GoalRelatedData({ tasks, online }: { tasks: BoardAgent[]; online: boolean }) {
  const [files, setFiles] = useState<Array<{ taskId: string; file: string }>>([])
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    if (!online || !tasks.length) { setFiles([]); setLoading(false); return }
    setLoading(true)
    setError('')
    void Promise.all(tasks.map(async (task) => {
      // Fetch report metadata for every child task in parallel.
      const result = await reportRequest({ action: 'task', taskId: task.id })
      return 'files' in result ? result.files.map((file) => ({ taskId: task.id, file })) : []
    })).then((groups) => {
      // Publish results only if this effect still owns the current task list.
      if (!cancelled) setFiles(groups.flat())
    }).catch((err) => {
      // Preserve the mounted view while displaying the retrieval failure.
      if (!cancelled) setError(String(err instanceof Error ? err.message : err))
    }).finally(() => {
      // Stop the loading indicator only for the active request batch.
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [online, tasks])

  const byId = new Map(tasks.map((task) => [task.id, task]))
  const items: RelatedItem[] = []
  const seen = new Set<string>()
  for (const task of tasks) {
    for (const [referenceIndex, reference] of (task.references ?? []).entries()) {
      const target = reference.url ?? reference.path ?? ''
      const key = `${task.id}:${target}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        kind: 'reference', key, taskId: task.id, taskName: task.name, reference, referenceIndex,
        title: reference.title,
        meta: reference.path ?? (reference.url ? referenceSource(reference) : task.name),
      })
    }
  }
  for (const entry of files) {
    const task = byId.get(entry.taskId)
    const key = `${entry.taskId}:${entry.file}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      kind: 'file', key, taskId: entry.taskId, taskName: task?.name ?? entry.taskId,
      file: entry.file, title: entry.file.split('/').at(-1) ?? entry.file,
      meta: `${task?.name ?? entry.taskId} · ${entry.file}`,
    })
  }

  /** Open a related URL or fetch its task-owned document contents. */
  async function open(item: RelatedItem) {
    if (!online || busyKey) return
    setBusyKey(item.key)
    setError('')
    try {
      if (item.kind === 'reference' && item.reference.url) {
        const url = new URL(item.reference.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('This link is not supported.')
        useStore.getState().pushBlade({ id: `agent-reference-${crypto.randomUUID()}`, title: item.title, kind: 'article', url: url.href, mode: 'reader', size: 'wide', hold: 'sticky' })
        return
      }
      const result = item.kind === 'file'
        ? await reportRequest({ action: 'task', taskId: item.taskId, file: item.file })
        : await reportRequest({ action: 'reference', taskId: item.taskId, index: item.referenceIndex })
      if (!('content' in result)) throw new Error('The selected document is unavailable.')
      useStore.getState().pushBlade({
        id: `agent-related-${crypto.randomUUID()}`,
        title: item.title,
        kind: 'markup',
        html: reportDocumentHtml(result.file, result.content),
        size: 'wide',
        hold: 'sticky',
      })
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusyKey('') }
  }

  if (!tasks.length || (!loading && !items.length && !error)) return null
  return <section className="ab-reference-section ab-goal-related" aria-label="Related data">
    <h3>Related data</h3>
    {loading && !items.length && <p role="status">Loading files...</p>}
    {!loading && !items.length && !error && <p>No linked files or references.</p>}
    {!!items.length && <ul className="ab-reference-list">{items.map((item) => <li key={item.key}>
      <button className="ab-related-card" type="button" disabled={!online || Boolean(busyKey)} onClick={() => void open(item)} title={`Open ${item.title}`}>
        <span className="ab-related-icon"><FileText size={16} aria-hidden="true" /></span>
        <span className="ab-related-copy"><strong>{busyKey === item.key ? 'Opening...' : item.title}</strong><small>{item.meta}</small></span>
        <ArrowUpRight size={14} className="ab-related-open" aria-hidden="true" />
      </button>
    </li>)}</ul>}
    {!online && <p role="status">Background agents are offline.</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}

/** Edit profile instructions and validate an optional recurring schedule. */
function ProfileEditor({ profile, onSave, onCancel }: { profile: AgentProfile | null; onSave: (input: AgentProfileInput) => Promise<void>; onCancel: () => void }) {
  const id = useId()
  const [name, setName] = useState(profile?.name ?? '')
  const [role, setRole] = useState(profile?.role ?? '')
  const [instructions, setInstructions] = useState(profile?.instructions ?? '')
  const [skills, setSkills] = useState<string[]>(profile?.skills ?? [])
  const [installed, setInstalled] = useState<InstalledSkill[] | null>(null)
  const [skillsError, setSkillsError] = useState('')
  const priorTrigger = profile?.schedule?.trigger
  const [scheduleKind, setScheduleKind] = useState<'none' | 'once' | 'interval' | 'daily' | 'weekly'>(priorTrigger?.type ?? 'none')
  const [at, setAt] = useState(priorTrigger?.type === 'once' ? localDateTime(priorTrigger.at) : '')
  const [minutes, setMinutes] = useState(priorTrigger?.type === 'interval' ? String(priorTrigger.minutes) : '60')
  const [time, setTime] = useState(priorTrigger && 'time' in priorTrigger ? priorTrigger.time : '09:00')
  const [days, setDays] = useState<number[]>(priorTrigger?.type === 'weekly' ? priorTrigger.days : [1, 2, 3, 4, 5])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    profileRequest({ action: 'skills' })
      .then((list) => { if (live) setInstalled(list) })
      .catch((err: unknown) => { if (live) { setInstalled([]); setSkillsError(err instanceof Error ? err.message : String(err)) } })
    return () => { live = false }
  }, [])

  /**
   * Everything the user can tick: what is installed now, plus anything this
   * profile already chose that is no longer on disk. A skill that has gone
   * stays visible and stays selected, so saving an unrelated edit cannot
   * quietly drop it. Nothing is called missing until the list has arrived,
   * or every saved choice would be libelled while the request is in flight.
   */
  const choices = useMemo(() => {
    if (installed === null) return []
    const list = installed.map((skill) => ({ ...skill, missing: false }))
    const known = new Set(list.map((skill) => skill.id))
    const gone = skills.filter((skillId) => !known.has(skillId))
      .map((skillId) => ({ id: skillId, name: skillId, description: 'Not installed on this machine.', missing: true }))
    return [...list, ...gone]
  }, [installed, skills])

  const toggleSkill = (skillId: string, on: boolean) =>
    setSkills((previous) => on ? [...previous.filter((value) => value !== skillId), skillId].sort() : previous.filter((value) => value !== skillId))

  /** Validate local schedule fields and pass the normalized profile to the caller. */
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    let schedule: AgentProfileInput['schedule'] = null
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      let trigger: ScheduleTrigger | null = null
      if (scheduleKind === 'once') {
        trigger = { type: 'once', at: onceFromLocal(at) }
      } else if (scheduleKind === 'interval') {
        const value = Number(minutes)
        if (!Number.isInteger(value) || value < 1 || value > 525600) throw new Error('Choose an interval from 1 to 525600 minutes.')
        trigger = { type: 'interval', minutes: value }
      } else if (scheduleKind === 'daily') trigger = { type: 'daily', time, timezone }
      else if (scheduleKind === 'weekly') {
        if (!days.length) throw new Error('Choose at least one weekday.')
        trigger = { type: 'weekly', time, timezone, days }
      }
      if (trigger) schedule = { trigger, priority: profile?.schedule?.priority ?? 3, ...(profile?.schedule?.execution && { execution: profile.schedule.execution }) }
      await onSave({ name, role, instructions, skills, schedule })
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return <form className="ab-profile-form" onSubmit={(event) => void submit(event)}>
    <label htmlFor={`${id}-name`}>Name<input id={`${id}-name`} value={name} maxLength={100} required disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
    <label htmlFor={`${id}-role`}>Role<input id={`${id}-role`} value={role} maxLength={500} required disabled={busy} onChange={(event) => setRole(event.target.value)} /></label>
    <label htmlFor={`${id}-instructions`}>Instructions<textarea id={`${id}-instructions`} value={instructions} maxLength={10000} rows={4} required disabled={busy} onChange={(event) => setInstructions(event.target.value)} /></label>
    <fieldset className="ab-weekdays ab-skills"><legend>Skills</legend>
      {installed === null && <p role="status">Loading skills...</p>}
      {installed !== null && !choices.length && <p>No skills are installed.</p>}
      {choices.map((skill) => <label key={skill.id} className={skill.missing ? 'ab-skill-missing' : undefined} title={skill.description}>
        <input type="checkbox" checked={skills.includes(skill.id)} disabled={busy} onChange={(event) => toggleSkill(skill.id, event.target.checked)} />
        {skill.name}{skill.missing ? ' (missing)' : ''}
      </label>)}
      {skillsError && <p role="alert">{skillsError}</p>}
    </fieldset>
    <label htmlFor={`${id}-schedule`}>Schedule<select id={`${id}-schedule`} value={scheduleKind} disabled={busy} onChange={(event) => setScheduleKind(event.target.value as typeof scheduleKind)}>
      <option value="none">Manual</option><option value="once">Once</option><option value="interval">Interval</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
    </select></label>
    {scheduleKind === 'once' && <label htmlFor={`${id}-at`}>Run at<input id={`${id}-at`} type="datetime-local" value={at} required disabled={busy} onChange={(event) => setAt(event.target.value)} /></label>}
    {scheduleKind === 'interval' && <label htmlFor={`${id}-minutes`}>Every minutes<input id={`${id}-minutes`} type="number" min="1" max="525600" value={minutes} required disabled={busy} onChange={(event) => setMinutes(event.target.value)} /></label>}
    {(scheduleKind === 'daily' || scheduleKind === 'weekly') && <label htmlFor={`${id}-time`}>Local time<input id={`${id}-time`} type="time" value={time} required disabled={busy} onChange={(event) => setTime(event.target.value)} /></label>}
    {scheduleKind === 'weekly' && <fieldset className="ab-weekdays"><legend>Days</legend>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => <label key={day}><input type="checkbox" checked={days.includes(index)} onChange={(event) => setDays((previous) => event.target.checked ? [...previous, index].sort() : previous.filter((value) => value !== index))} />{day}</label>)}</fieldset>}
    <div className="ab-profile-actions"><button type="submit" disabled={busy}><Save size={15} aria-hidden="true" />{busy ? 'Saving...' : 'Save profile'}</button><button type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
    {error && <p role="alert">{error}</p>}
  </form>
}

/** Select the appropriate blocker form, references, and reports for one row. */
function DecisionReferenceSection({ row, online }: { row: BoardAgent; online: boolean }) {
  if (row.questions?.length && row.parentId) return <DecisionForm task={row} goalId={row.parentId} online={online} />
  return <>
    {!!row.references?.length && <ReferenceList taskId={row.id} references={row.references} online={online} />}
    {row.kind === 'task' && <ReportContent taskId={row.id} online={online} />}
  </>
}

/** Render searchable agent work, history, decisions, reports, and reusable profiles. */
export function AgentBoard() {
  const board = useStore((s) => s.agentBoard)
  const online = useStore((s) => s.agentsOnline)
  const seen = useStore((s) => s.agentsSeen)
  const open = useStore((s) => s.boardOpen)
  const exclusiveCommandWindows = useStore((s) => s.exclusiveCommandWindows)
  const session = useStore((s) => s.sessionAgents)
  const [view, setView] = useState<'agents' | 'profiles'>('agents')
  const [history, setHistory] = useState<AgentBoardData | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [pendingSelectionId, setPendingSelectionId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [profilesError, setProfilesError] = useState('')
  const [profileNotice, setProfileNotice] = useState('')
  const [profileRevision, setProfileRevision] = useState(0)
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<AgentProfile | null>(null)
  const [profileBusy, setProfileBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (view !== 'agents' || !open || !online) return
    setLoading(true)
    setError('')
    void reportRequest({ action: 'history' }).then((data) => {
      // Apply history only if the agents view is still the active request owner.
      if (!cancelled) setHistory(data)
    }).catch((err) => {
      // Keep errors scoped to this mounted view.
      if (!cancelled) setError(String(err.message ?? err))
    }).finally(() => {
      // Clear loading only after the current history request settles.
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [view, open, online, revision])
  useEffect(() => {
    let cancelled = false
    if (view !== 'profiles' || !open || !online) return
    setProfilesLoading(true)
    setProfilesError('')
    void profileRequest({ action: 'list' }).then((data) => {
      // Avoid applying a late response after leaving the profiles view.
      if (!cancelled) setProfiles(data)
    }).catch((err) => {
      // Show failures only while this profiles request is still current.
      if (!cancelled) setProfilesError(String(err.message ?? err))
    }).finally(() => {
      // Stop the profile spinner after the current request settles.
      if (!cancelled) setProfilesLoading(false)
    })
    return () => { cancelled = true }
  }, [view, open, online, profileRevision])
  const source = mergeBoardData(board, history)

  // The service being offline must not hide a subagent: a turn can dispatch one
  // with the agent service switched off entirely.
  const rows = useMemo(() => mergeBoard(source, session, { history: true }), [source, session])
  const needle = query.trim().toLowerCase()
  const filtered = useMemo(() => needle
    ? rows.filter((row) => row.kind !== 'subagent' && `${row.name} ${row.goal ?? ''} ${row.activity} ${row.result ?? ''} ${row.status}`.toLowerCase().includes(needle))
    : mainTaskRows(rows), [rows, needle])
  const sessionRows = useMemo(() => view === 'agents' ? rows.filter((row) => row.kind === 'subagent' && `${row.name} ${row.activity} ${row.result ?? ''}`.toLowerCase().includes(needle)) : [], [view, rows, needle])
  const capacity = online ? (board?.capacity ?? null) : null
  const pool = capacityLine(capacity)
  const selected = rows.find((row) => row.id === selectedId)
  const selectedGoal = selected?.kind === 'goal' ? source?.goals.find((goal) => goal.id === selected.id)
    : selected?.parentId ? source?.goals.find((goal) => goal.id === selected.parentId) : undefined
  const selectedLiveGoal = selected?.kind === 'goal' ? board?.goals.find((goal) => goal.id === selected.id)
    : selected?.parentId ? board?.goals.find((goal) => goal.id === selected.parentId) : undefined
  const selectedTasks = useMemo(() => selected?.kind === 'goal' ? rows.filter((row) => row.kind === 'task' && row.parentId === selected.id)
    : selected?.parentId ? rows.filter((row) => row.kind === 'task' && row.parentId === selected.parentId) : [], [rows, selected])
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0] ?? null
  const profileSchedule = selectedProfile?.scheduleId ? board?.schedules?.find((schedule) => schedule.id === selectedProfile.scheduleId) : undefined

  useEffect(() => {
    const candidates = [...filtered, ...sessionRows]
    if (pendingSelectionId && rows.some((row) => row.id === pendingSelectionId)) {
      setSelectedId(pendingSelectionId)
      setPendingSelectionId('')
      return
    }
    if (selectedId && candidates.some((row) => row.id === selectedId)) return
    if (candidates.length) setSelectedId(candidates[0].id)
  }, [filtered, sessionRows, selectedId, pendingSelectionId, rows])
  useEffect(() => {
    if (selectedProfileId && profiles.some((profile) => profile.id === selectedProfileId)) return
    if (profiles.length) setSelectedProfileId(profiles[0].id)
    else setSelectedProfileId('')
  }, [profiles, selectedProfileId])

  // An explicitly opened window must remain available for profile management.
  if (!open && !seen && !session.length) return null
  if (exclusiveCommandWindows && !open) return null
  if (!open && !rows.some((r) => LIVE.includes(r.status))) return null

  /** Create or update the selected profile and refresh profile-editor state. */
  async function saveProfile(input: AgentProfileInput) {
    if (!online) throw new Error('Background agents are offline.')
    setProfileBusy(true)
    setProfilesError('')
    setProfileNotice('')
    try {
      const saved = editingProfile
        ? await profileRequest({ action: 'update', profileId: editingProfile.id, changes: input })
        : await profileRequest({ action: 'create', profile: input })
      const profile = saved as AgentProfile
      setProfiles((previous) => editingProfile ? previous.map((entry) => {
        // Replace the edited profile in place while preserving list order.
        return entry.id === profile.id ? profile : entry
      }) : [profile, ...previous])
      setSelectedProfileId(profile.id)
      setEditorOpen(false)
      setEditingProfile(null)
      setProfileNotice('Profile saved.')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setProfilesError(message)
      throw err
    } finally { setProfileBusy(false) }
  }

  /** Start a goal from a profile and select it when it appears on the board. */
  async function runProfile(profile: AgentProfile) {
    setProfileBusy(true)
    setProfilesError('')
    try {
      const goal = await profileRequest({ action: 'run', profileId: profile.id })
      setPendingSelectionId(goal.id)
      setView('agents')
      setProfileNotice('Run started.')
    } catch (err) { setProfilesError(err instanceof Error ? err.message : String(err)) }
    finally { setProfileBusy(false) }
  }

  /** Confirm and delete a reusable profile without affecting existing runs. */
  async function deleteProfile(profile: AgentProfile) {
    if (!online || !window.confirm(`Delete '${profile.name}'? Existing runs will remain.`)) return
    setProfileBusy(true)
    setProfilesError('')
    try {
      await profileRequest({ action: 'delete', profileId: profile.id })
      setProfiles((previous) => previous.filter((entry) => {
        // Remove only the deleted profile from the cached roster.
        return entry.id !== profile.id
      }))
      setProfileNotice('Profile deleted.')
    } catch (err) { setProfilesError(err instanceof Error ? err.message : String(err)) }
    finally { setProfileBusy(false) }
  }

  /** Run or change the lifecycle of the selected profile's linked schedule. */
  async function updateProfileSchedule(action: 'pause' | 'resume' | 'run') {
    if (!selectedProfile?.scheduleId || !online) return
    setProfileBusy(true)
    setProfilesError('')
    try {
      if (action === 'run') await scheduleRequest({ action: 'run', id: selectedProfile.scheduleId })
      else await scheduleRequest({ action: 'update', id: selectedProfile.scheduleId, change: { action } })
      setProfileRevision((value) => value + 1)
      setProfileNotice(action === 'run' ? 'Scheduled run started.' : `Schedule ${action}d.`)
    } catch (err) { setProfilesError(err instanceof Error ? err.message : String(err)) }
    finally { setProfileBusy(false) }
  }

  /** Confirm destructive goal actions and send the selected lifecycle change. */
  async function changeGoal(action: 'pause' | 'resume' | 'abandon') {
    if (!selectedGoal || !online) return
    if (action === 'abandon' && !window.confirm(`Abandon “${selectedGoal.title}” and stop its queued work?`)) return
    setProfileBusy(true)
    setError('')
    try {
      await goalControlRequest({ goalId: selectedGoal.id, action })
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setProfileBusy(false) }
  }

  /**
   * Delete an idle agent for good: its record, its tasks and everything they
   * saved. The service owns the rule about what may go — this only refuses
   * early, asks once, and then hands the selection on to the next row so the
   * detail pane is never left describing something that no longer exists.
   */
  async function deleteAgent(row: BoardAgent) {
    if (!online) return
    const blocked = deleteBlockReason(row)
    if (blocked) { setError(blocked); return }
    if (!window.confirm(`Delete “${row.name}” permanently?\n\nThis removes the agent and its task history, results and saved reports. It cannot be undone.`)) return
    const neighbour = rosterRows.filter((entry) => entry.id !== row.id && entry.kind !== 'subagent')
    const next = neighbour[Math.min(rosterRows.findIndex((entry) => entry.id === row.id), neighbour.length - 1)]
    setProfileBusy(true)
    setError('')
    try {
      await goalControlRequest({ goalId: row.id, action: 'erase' })
      setSelectedId(next?.id ?? '')
      setPendingSelectionId(next?.id ?? '')
      setRevision((value) => value + 1)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setProfileBusy(false) }
  }

  const rosterRows = [...filtered, ...sessionRows]
  const deleteBlock = deleteBlockReason(selected)
  // Group the visible roster by lifecycle state for predictable scanning.
  const groups = [
    { label: 'Waiting', key: 'waiting', rows: rosterRows.filter((row) => stateGroup(row) === 'waiting') },
    { label: 'Working', key: 'working', rows: rosterRows.filter((row) => stateGroup(row) === 'working') },
    { label: 'Paused', key: 'paused', rows: rosterRows.filter((row) => stateGroup(row) === 'paused') },
    { label: 'Idle', key: 'idle', rows: rosterRows.filter((row) => stateGroup(row) === 'idle') },
  ].filter((group) => group.rows.length)

  return (
    <div className="agent-board" role="region" aria-label="Agent workspace">
      <header className="ab-head"><span>JARVIS AGENTS</span><span className="ab-summary">{agentSummary(rows)}{seen && !online && <span className="ab-offline"> · offline</span>}</span></header>
      <div className="ab-recall">
        <div role="tablist" aria-label="Agent workspace">
          <button type="button" role="tab" aria-selected={view === 'agents'} onClick={() => setView('agents')}>Agents</button>
          <button type="button" role="tab" aria-selected={view === 'profiles'} onClick={() => setView('profiles')}>Profiles</button>
        </div>
        {view === 'agents' && <button type="button" title="Refresh agents and history" aria-label="Refresh agents and history" disabled={!online || loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} /></button>}
        {view === 'profiles' && <button type="button" title="Create profile" aria-label="Create profile" disabled={!online || editorOpen} onClick={() => { setEditingProfile(null); setEditorOpen(true); setProfilesError('') }}><Plus size={16} /></button>}
        <input type="search" aria-label={view === 'profiles' ? 'Search agent profiles' : 'Search agent work'} placeholder={view === 'profiles' ? 'Search profiles' : 'Search agents and tasks'} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {pool && view === 'agents' && <div className="ab-pool"><span className="ab-pool-line">{pool}</span>{capacity && capacity.endpoints.length > 1 && <span className="ab-eps">{capacity.endpoints.map((endpoint) => <span key={endpoint.id} className="ab-ep" data-down={endpoint.healthy ? undefined : ''} title={`${endpoint.label}${endpoint.model ? ` · ${endpoint.model}` : ''} · ${endpoint.kind}${endpoint.healthy ? '' : ' · unreachable'}`}>{endpoint.id} {endpoint.running}/{endpoint.concurrency}</span>)}</span>}</div>}
      {view === 'agents' && loading && <p role="status">Loading saved work...</p>}
      {view === 'agents' && error && <p role="alert">{error}</p>}
      {view === 'profiles' && profilesLoading && <p role="status">Loading profiles...</p>}
      {view === 'profiles' && profilesError && <p role="alert">{profilesError}</p>}
      {view === 'agents' && seen && !online && <div className="ab-empty">Background agents are offline.</div>}
      {view === 'profiles' && !online && <div className="ab-empty">Background agents are offline.</div>}
      <div className={`ab-workspace${view === 'profiles' ? ' ab-workspace-profiles' : ''}`}>
        {view === 'profiles' ? <>
          <aside className="ab-roster" aria-label="Agent profiles">
            {!profiles.filter((profile) => `${profile.name} ${profile.role} ${profile.instructions}`.toLowerCase().includes(needle)).length && !profilesLoading && <p className="ab-empty">{query ? 'No matching profiles.' : 'No profiles yet.'}</p>}
            {profiles.filter((profile) => `${profile.name} ${profile.role} ${profile.instructions}`.toLowerCase().includes(needle)).map((profile) => <button key={profile.id} type="button" className="ab-roster-row" data-selected={profile.id === selectedProfile?.id ? '' : undefined} onClick={() => { setSelectedProfileId(profile.id); setEditorOpen(false); setEditingProfile(null) }}>
              <span className="ab-roster-line"><span className="ab-name">{profile.name}</span><span className="ab-kind">{profile.scheduleId ? 'scheduled' : 'manual'}</span></span>
              <span className="ab-roster-sub">{profile.role}</span>
            </button>)}
          </aside>
          <main className="ab-detail">
            {editorOpen ? <ProfileEditor key={editingProfile?.id ?? 'new'} profile={editingProfile} onSave={saveProfile} onCancel={() => { setEditorOpen(false); setEditingProfile(null) }} />
              : selectedProfile ? <>
                <div className="ab-detail-head"><div><p className="ab-kicker">REUSABLE PROFILE</p><h2>{selectedProfile.name}</h2><p className="ab-role">{selectedProfile.role}</p></div>
                  <div className="ab-actions"><button type="button" title="Run profile" disabled={!online || profileBusy} onClick={() => void runProfile(selectedProfile)}><Play size={15} aria-hidden="true" />Run</button><button type="button" title="Edit profile" disabled={!online || profileBusy} onClick={() => { setEditingProfile(selectedProfile); setEditorOpen(true) }}><Pencil size={15} aria-hidden="true" />Edit</button><button type="button" title="Delete profile" disabled={!online || profileBusy} onClick={() => void deleteProfile(selectedProfile)}><Trash2 size={15} aria-hidden="true" /></button></div>
                </div>
                <details className="ab-profile-instructions"><summary>Instructions</summary><p>{selectedProfile.instructions}</p></details>
                {profileSchedule && <section className="ab-profile-schedule"><h3>{profileSchedule.status === 'paused' ? 'Schedule paused' : profileSchedule.status}</h3><p>{profileSchedule.nextRunAt ? `Next run ${new Date(profileSchedule.nextRunAt).toLocaleString()}` : 'No future run'}</p><div className="ab-actions"><button type="button" disabled={!online || profileBusy || !['active', 'paused'].includes(profileSchedule.status)} onClick={() => void updateProfileSchedule(profileSchedule.status === 'paused' ? 'resume' : 'pause')}>{profileSchedule.status === 'paused' ? <Play size={15} /> : <Pause size={15} />}{profileSchedule.status === 'paused' ? 'Resume schedule' : 'Pause schedule'}</button><button type="button" disabled={!online || profileBusy || !['active', 'paused'].includes(profileSchedule.status)} onClick={() => void updateProfileSchedule('run')}><Play size={15} />Run now</button></div></section>}
                {!selectedProfile.scheduleId && <p className="ab-empty">Manual runs only.</p>}
              </> : <p className="ab-empty">Choose a profile or create one.</p>}
            {profileNotice && <p role="status" className="ab-notice">{profileNotice}</p>}
          </main>
        </> : <>
          <aside className="ab-roster" aria-label="Agent work">
            {!groups.length && !loading && <p className="ab-empty">{needle ? 'No matching work.' : 'No agent work yet.'}</p>}
            {groups.map((group) => <section className="ab-roster-group" key={group.label}><h3>{group.label}<span>{group.rows.length}</span></h3>{group.rows.map((row) => <button key={`${row.kind}-${row.id}`} type="button" className="ab-roster-row" data-state-group={group.key} data-selected={row.id === selectedId ? '' : undefined} data-kind={row.kind} onClick={() => setSelectedId(row.id)}>
              <span className="ab-roster-copy"><span className="ab-roster-name">{row.name}</span>{row.kind !== 'goal' && <span className="ab-roster-sub">{row.goal || 'JARVIS session'}</span>}</span>
              <span className="ab-roster-status">{statusLabel(row.status)}</span>
            </button>)}</section>)}
          </aside>
          <main className="ab-detail" aria-live="polite">
            {!selected ? <p className="ab-empty">Select an agent to see details.</p> : <>
              <div className="ab-detail-head"><div><p className="ab-kicker">{KIND_LABEL[selected.kind]}{selected.goal && selected.kind === 'task' ? ` · ${selected.goal}` : ''}</p><h2>{selected.name}</h2><span className={`ab-chip ab-chip-${selected.status}`}>{statusLabel(selected.status)}</span></div>
                {selected.kind === 'goal' && view === 'agents' && <div className="ab-actions">
                  {selectedLiveGoal && ['active', 'paused'].includes(selectedLiveGoal.status) && <>{selectedLiveGoal.status === 'paused' ? <button type="button" disabled={!online || profileBusy} onClick={() => void changeGoal('resume')}><Play size={15} aria-hidden="true" />Resume</button> : <button type="button" disabled={!online || profileBusy} onClick={() => void changeGoal('pause')}><Pause size={15} aria-hidden="true" />Pause</button>}<button type="button" disabled={!online || profileBusy} onClick={() => void changeGoal('abandon')}>Stop</button></>}
                  <button type="button" title={deleteBlock ?? `Delete “${selected.name}” and its history permanently`} aria-label={deleteBlock ?? `Delete “${selected.name}” and its history permanently`} disabled={!online || profileBusy || deleteBlock !== null} onClick={() => void deleteAgent(selected)}><Trash2 size={15} aria-hidden="true" />Delete</button>
                </div>}
              </div>
              {selected.kind === 'goal' && <>
                {selected.brief && <p className="ab-goal-outcome">{selected.brief}</p>}
                {selectedGoal?.profileSnapshot && <details className="ab-profile-instructions"><summary>{selectedGoal.profileSnapshot.role}</summary><p>{selectedGoal.profileSnapshot.instructions}</p></details>}
                {selected.progress !== null && <div className="ab-detail-progress"><span>{selected.activity}</span><span className="ab-bar"><span style={{ width: `${selected.progress * 100}%` }} /></span></div>}
                {!!selectedTasks.length && <section className="ab-task-section" aria-label="Tasks"><h3>Tasks <span>{selectedTasks.length}</span></h3><ul className="ab-task-list">{selectedTasks.map((task) => <li key={task.id}><button type="button" data-selected={task.id === selectedId ? '' : undefined} onClick={() => setSelectedId(task.id)}><span className={`ab-chip ab-chip-${task.status}`}>{statusLabel(task.status)}</span><span className="ab-task-name">{task.name}</span></button></li>)}</ul></section>}
                <TaskResult row={selected} />
                {view === 'agents' && selected.awaitingResponse && selectedLiveGoal && <GoalDecisionForm key={selected.id} goalId={selected.id} tasks={selectedTasks} online={online} />}
                {!(view === 'agents' && selected.awaitingResponse && selectedLiveGoal) && <GoalRelatedData tasks={selectedTasks} online={online} />}
                {error && <p role="alert">{error}</p>}
              </>}
              {selected.kind === 'task' && <>
                {selected.brief && <p className="ab-goal-outcome">{selected.brief}</p>}
                {selected.result && <section className="ab-main-result"><h3>Result</h3><p>{selected.result}</p></section>}
                {selected.approval && <div className="ab-approval" role="group" aria-label={`Approval required: ${selected.approval.action}`}><div className="ab-approval-heading"><span className="ab-ask">{selected.approval.category} · {selected.approval.action}</span>{selected.approval.created && <span className="ab-approval-age">Requested {ago(selected.approval.created)}</span>}</div><code className="ab-approval-detail">{selected.approval.detail}</code>{selectedLiveGoal && <span className="ab-actions"><button type="button" onClick={() => decideApproval(selected.approval!.id, 'approve')}>Approve</button><button type="button" onClick={() => decideApproval(selected.approval!.id, 'deny')}>Deny</button></span>}</div>}
                {view === 'agents' && selected.awaitingResponse && selected.parentId && selected.decisionRequired && !selected.questions?.length && <p className="ab-decision-error" role="alert">This saved decision has no choices. Ask the agent to submit a new decision form.</p>}
                {view === 'agents' && selected.awaitingResponse && selected.parentId && !selected.decisionRequired && !selected.questions?.length && selectedLiveGoal && <AttentionReply key={selected.id} goalId={selected.parentId} name={selected.name} paused={selectedLiveGoal.status === 'paused'} online={online} />}
                <DecisionReferenceSection row={selected} online={online} />
                {error && <p role="alert">{error}</p>}
              </>}
              {selected.kind === 'subagent' && <><p className="ab-goal-outcome">{selected.brief || selected.activity}</p>{selected.result && <p className="ab-subagent-result">{selected.result}</p>}</>}
            </>}
          </main>
        </>}
      </div>
      {seen && !online && <p role="status" className="ab-offline-note">Background agent service offline.</p>}
    </div>
  )
}
