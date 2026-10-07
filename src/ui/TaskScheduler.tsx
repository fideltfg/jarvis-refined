import { useEffect, useId, useRef, useState } from 'react'
import { CalendarClock, ClipboardList, Pencil, Play, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import { providerState, scheduleRequest } from '../lib/bridge'
import { describeTrigger, localDateTime, onceFromLocal, WEEKDAYS, type Schedule, type ScheduleExecution, type ScheduleInput, type ScheduleRequest, type ScheduleTrigger } from '../lib/schedules'

const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'None'
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const zones = [...new Set([localZone, 'UTC', ...Intl.supportedValuesOf('timeZone')])].sort()
const providerLabels = { claude: 'Claude', openai: 'OpenAI', local: 'Local' }

export function TaskScheduler({ inline = false }: { inline?: boolean }) {
  const open = useStore((state) => state.commandWindow === 'scheduler')
  const board = useStore((state) => state.agentBoard)
  const online = useStore((state) => state.agentsOnline)
  const panel = useRef<HTMLElement>(null)
  const lock = useRef(false)
  const formId = useId()
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null)
  const [title, setTitle] = useState('')
  const [outcome, setOutcome] = useState('')
  const [priority, setPriority] = useState(3)
  const [provider, setProvider] = useState<ScheduleExecution['provider']>('claude')
  const [model, setModel] = useState('')
  const models = board?.scheduleModels ?? { claude: ['opus', 'sonnet'] }
  const [mode, setMode] = useState<ScheduleTrigger['type']>('once')
  const [at, setAt] = useState('')
  const [amount, setAmount] = useState(30)
  const [unit, setUnit] = useState(1)
  const [time, setTime] = useState('09:00')
  const [timezone, setTimezone] = useState(localZone)
  const [days, setDays] = useState([1, 2, 3, 4, 5])
  const close = () => useStore.getState().setCommandWindow(null)

  useEffect(() => {
    if (board?.schedules) setSchedules(board.schedules)
  }, [board])

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        useStore.getState().setCommandWindow(null)
      } else if (event.key === 'Tab' && !inline) {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])]
        const first = controls[0]
        const last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, inline])

  async function perform(request: ScheduleRequest) {
    if (lock.current) return false
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await scheduleRequest(request)
      if (Array.isArray(result)) setSchedules(result)
      else setSchedules((current) => result.status === 'deleted' ? current.filter((schedule) => schedule.id !== result.id) : [result, ...current.filter((schedule) => schedule.id !== result.id)])
      setNotice(request.action === 'run' ? 'Run queued for planning.' : request.action === 'list' ? 'Schedules refreshed.' : 'Schedule saved.')
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return false
    } finally { lock.current = false; setBusy(false) }
  }

  function edit(schedule: Schedule | 'new') {
    setEditing(schedule)
    setError('')
    setNotice('')
    setTitle(schedule === 'new' ? '' : schedule.title)
    setOutcome(schedule === 'new' ? '' : schedule.outcome)
    setPriority(schedule === 'new' ? 3 : schedule.priority)
    const current = providerState()
    const preferred = current.selected as ScheduleExecution['provider']
    const execution = schedule === 'new'
      ? { provider: models[preferred]?.length ? preferred : 'claude' as const, model: current.model }
      : schedule.execution ?? { provider: 'claude' as const, model: models.claude?.[0] ?? 'opus' }
    setProvider(execution.provider)
    setModel(schedule !== 'new' && schedule.execution ? execution.model : models[execution.provider]?.includes(execution.model) ? execution.model : models[execution.provider]?.[0] ?? '')
    const trigger = schedule === 'new' ? null : schedule.trigger
    setMode(trigger?.type ?? 'once')
    setAt(localDateTime(trigger?.type === 'once' ? trigger.at : new Date(Date.now() + 3600000).toISOString()))
    const minutes = trigger?.type === 'interval' ? trigger.minutes : 30
    const factor = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1
    setAmount(minutes / factor)
    setUnit(factor)
    setTime(trigger && 'time' in trigger ? trigger.time : '09:00')
    setTimezone(trigger && 'timezone' in trigger ? trigger.timezone : localZone)
    setDays(trigger?.type === 'weekly' ? trigger.days : [1, 2, 3, 4, 5])
    requestAnimationFrame(() => document.getElementById(`${formId}-title`)?.focus())
  }

  async function save() {
    if (!editing || busy) return
    try {
      const trigger: ScheduleTrigger = mode === 'once' ? { type: 'once', at: onceFromLocal(at) }
        : mode === 'interval' ? { type: 'interval', minutes: amount * unit }
          : mode === 'daily' ? { type: 'daily', time, timezone } : { type: 'weekly', time, timezone, days: [...days].sort() }
      const execution = { provider, model }
      if (!models[provider]?.includes(model)) throw new Error('Choose a configured provider and model.')
      const input: ScheduleInput = { title: title.trim(), outcome: outcome.trim(), priority, trigger, execution }
      if (!input.title || !input.outcome) throw new Error('Enter a title and the outcome you want Jarvis to achieve.')
      if (mode === 'weekly' && !days.length) throw new Error('Select at least one weekday.')
      if (editing === 'new' && trigger.type === 'once' && Date.parse(trigger.at) <= Date.now()) throw new Error('Choose a date and time in the future.')
      const values: Partial<ScheduleInput> = { title: input.title, outcome: input.outcome, priority, execution }
      if (editing !== 'new') {
        const previous = editing.trigger.type === 'interval' ? { type: 'interval', minutes: editing.trigger.minutes } : editing.trigger
        if (JSON.stringify(previous) !== JSON.stringify(trigger)) values.trigger = trigger
      }
      const success = await perform(editing === 'new' ? { action: 'create', input } : { action: 'update', id: editing.id, change: { action: 'edit', values } })
      if (success) setEditing(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }

  if (!open) return null
  const form = editing && <form className="ts-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
    <div className="ts-form-head"><h3>{editing === 'new' ? 'New scheduled task' : 'Edit schedule'}</h3><button type="button" title="Cancel editing" aria-label="Cancel editing" disabled={busy} onClick={() => setEditing(null)}><X size={16} /> Cancel</button></div>
    <fieldset disabled={!online || busy}>
      <label htmlFor={`${formId}-title`}>Title<input id={`${formId}-title`} required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Outcome<textarea required maxLength={10000} rows={3} value={outcome} onChange={(event) => setOutcome(event.target.value)} /></label>
      <div className="ts-field-pair">
        <label>Provider<select aria-label="Provider" value={provider} onChange={(event) => {
          const selected = event.target.value as ScheduleExecution['provider']
          setProvider(selected)
          setModel(models[selected]?.[0] ?? '')
        }}>{([...new Set([provider, ...Object.keys(models)])] as ScheduleExecution['provider'][]).map((value) => <option key={value} value={value} disabled={!models[value]?.length}>{providerLabels[value]}{!models[value]?.length ? ' (unavailable)' : ''}</option>)}</select></label>
        <label>Model<select aria-label="Model" required value={model} onChange={(event) => setModel(event.target.value)}>{[...new Set([model, ...(models[provider] ?? [])])].filter(Boolean).map((value) => <option key={value} value={value} disabled={!models[provider]?.includes(value)}>{value}{!models[provider]?.includes(value) ? ' (unavailable)' : ''}</option>)}</select></label>
      </div>
      <div className="ts-modes" role="group" aria-label="Schedule type">{(['once', 'interval', 'daily', 'weekly'] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{value === 'once' ? 'Once' : value === 'interval' ? 'Interval' : value === 'daily' ? 'Daily' : 'Weekly'}</button>)}</div>
      {mode === 'once' && <label>Date and time ({localZone})<input type="datetime-local" required value={at} onChange={(event) => setAt(event.target.value)} /></label>}
      {mode === 'interval' && <div className="ts-field-pair"><label>Every<input type="number" required min={1} max={Math.floor(525600 / unit)} step={1} value={amount} onChange={(event) => setAmount(Number(event.target.value))} /></label><label>Unit<select aria-label="Unit" value={unit} onChange={(event) => setUnit(Number(event.target.value))}><option value={1}>Minutes</option><option value={60}>Hours</option><option value={1440}>Days</option></select></label></div>}
      {(mode === 'daily' || mode === 'weekly') && <><label>Time<input type="time" required value={time} onChange={(event) => setTime(event.target.value)} /></label><label>Timezone<select aria-label="Timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)}>{[...new Set([timezone, ...zones])].map((zone) => <option value={zone} key={zone}>{zone}</option>)}</select></label></>}
      {mode === 'weekly' && <div className="ts-weekdays" role="group" aria-label="Weekdays">{WEEKDAYS.map((day, index) => <label key={day}><input type="checkbox" checked={days.includes(index)} onChange={() => setDays((current) => current.includes(index) ? current.filter((value) => value !== index) : [...current, index])} />{day}</label>)}</div>}
      <label>Priority<select aria-label="Priority" value={priority} onChange={(event) => setPriority(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}{value === 1 ? ' · Urgent' : value === 3 ? ' · Normal' : value === 5 ? ' · Low' : ''}</option>)}</select></label>
      <button type="submit" className="ts-save"><Save size={16} /> {busy ? 'Saving...' : 'Save schedule'}</button>
    </fieldset>
  </form>
  const content = (
    <section ref={panel} tabIndex={-1} className={`task-scheduler${inline ? ' task-scheduler-inline' : ''}`} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : true} aria-label="Task scheduler" onClick={(event) => event.stopPropagation()}>
      <header className="ts-head">
        <CalendarClock size={18} aria-hidden="true" /><h2>Task scheduler</h2><span className="ts-count">{schedules.length}</span>
        <div className="ts-tools">
          <button type="button" aria-label="Refresh schedules" title="Refresh schedules" disabled={busy} onClick={() => void perform({ action: 'list' })}><RefreshCw size={16} /> Refresh</button>
          <button type="button" disabled={!online || busy} onClick={() => edit('new')}><Plus size={16} /> New task</button>
          <button type="button" aria-label="Close task scheduler" title="Close task scheduler" onClick={close}><X size={16} /> Close</button>
        </div>
      </header>
      {!online && <p className="ts-offline" role="status">Background agents are offline. Schedules cannot be changed or run.</p>}
      {error && <p className="ts-error" role="alert">{error}</p>}
      {notice && <p className="ts-notice" role="status">{notice}</p>}
      <div className="ts-body">
        <div className="ts-list" aria-label="Scheduled tasks">
          {!schedules.length && <p className="ts-empty">No scheduled tasks.</p>}
          {schedules.map((schedule) => {
            const inFlight = Boolean(schedule.pendingOccurrence) || Boolean(schedule.lastStatus && !['done', 'abandoned'].includes(schedule.lastStatus))
            return <div className="ts-entry" key={schedule.id}>
            <article className="ts-row">
              <div className="ts-row-title"><h3>{schedule.title}</h3><span className={`ts-state ts-state-${schedule.status}`}>{schedule.status}</span></div>
              <p className="ts-recurrence">{describeTrigger(schedule.trigger)}</p>
              <p className="ts-recurrence">{schedule.execution ? `${providerLabels[schedule.execution.provider]} / ${schedule.execution.model}` : 'Claude / automatic'}</p>
              <dl className="ts-timing"><div><dt>Next run</dt><dd>{schedule.status === 'completed' ? 'Completed' : dateTime(schedule.nextRunAt)}</dd></div><div><dt>Last run</dt><dd>{dateTime(schedule.lastRunAt)}{schedule.lastStatus ? ` · ${schedule.lastStatus}` : ''}</dd></div></dl>
              {schedule.lastSummary && <p className="ts-result">{schedule.lastSummary}</p>}
              {schedule.error && <p className="ts-error">{schedule.error}</p>}
              <div className="ts-row-actions">
                {schedule.status !== 'completed' && <label className="ts-toggle"><input type="checkbox" checked={schedule.status === 'active'} disabled={!online || busy} onChange={() => void perform({ action: 'update', id: schedule.id, change: { action: schedule.status === 'active' ? 'pause' : 'resume' } })} /> Enabled</label>}
                <span className="ts-action-icons">
                  {schedule.lastGoalId && <button type="button" title="Open agent board" aria-label={`Open agent board for ${schedule.title}`} onClick={() => useStore.getState().setCommandWindow('agents')}><ClipboardList size={16} /> Board</button>}
                  <button type="button" title="Run now" aria-label={`Run now: ${schedule.title}`} disabled={!online || busy || inFlight || schedule.status === 'completed'} onClick={() => void perform({ action: 'run', id: schedule.id })}><Play size={16} /> Run</button>
                  <button type="button" title="Edit schedule" aria-label={`Edit schedule: ${schedule.title}`} disabled={!online || busy || Boolean(schedule.pendingOccurrence)} onClick={() => edit(schedule)}><Pencil size={16} /> Edit</button>
                  <button type="button" title="Delete schedule" aria-label={`Delete schedule: ${schedule.title}`} disabled={!online || busy} onClick={() => {
                    if (window.confirm(`Delete schedule "${schedule.title}"? Future runs will stop. Existing work will not be cancelled.`)) void perform({ action: 'update', id: schedule.id, change: { action: 'delete' } })
                  }}><Trash2 size={16} /> Delete</button>
                </span>
              </div>
            </article>
            {editing !== 'new' && editing?.id === schedule.id && form}
            </div>
          })}
          {editing === 'new' && form}
        </div>
      </div>
    </section>
  )
  return inline ? content : <div className="command-scrim" onClick={close}>{content}</div>
}