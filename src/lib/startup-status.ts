import type { AgentBoardData, AgentCapacity, AgentTask, SessionAgent } from './board'
import { describeTrigger, type Schedule } from './schedules.ts'

type Task = AgentTask & {
  workspace?: string | null
  archived?: boolean
  remote?: { endpointId: string } | null
  progress?: { at: string; text: string } | null
  result?: { summary?: string; artifacts?: Array<string | { path?: string }> } | null
}

export type StartupSnapshot = {
  observedAt: string
  board: (Omit<AgentBoardData, 'goals'> & { goals: Array<{ id: string; title: string; status: string; notes?: string; tasks: Task[] }>; schedules?: Schedule[] }) | null
  schedules: Schedule[] | null
  capacity: AgentCapacity | null
  sessionAgents: Array<SessionAgent & { live?: boolean }> | null
  memory: { focus?: string; goals?: string[]; tasks?: Array<{ text: string }>; log?: Array<{ date?: string; text: string }> } | null
  looseEnds: { items: Array<{ project?: string; action: string; state?: string; status: string }> } | null
  errors: Array<{ source: string; message: string }>
}

const statusText = (status: string) => status.replaceAll('_', ' ')

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)

const displayDate = (value: string) => Number.isNaN(Date.parse(value)) ? value :
  new Date(value).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  })

export function renderStartupStatus(snapshot: StartupSnapshot): string {
  const sections: string[] = []
  const record = (title: string, status: string, lines: string[] = [], details: string[] = []) =>
    `<li class="startup-report-row"><div class="startup-report-row-heading"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(status)}</span></div>` +
    lines.map(line => `<p>${escapeHtml(line)}</p>`).join('') +
    (details.length ? `<details><summary>Details</summary><ul>${details.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul></details>` : '') + '</li>'
  const section = (title: string, description: string, rows: string[]) => {
    sections.push(`<section class="startup-report-section"><h2>${escapeHtml(title)}</h2><p class="startup-report-meta">${escapeHtml(description)}</p>${rows.length ? `<ul class="startup-report-list">${rows.join('')}</ul>` : ''}</section>`)
  }
  const board = snapshot.board
  if (board) {
    const tasks = board.goals.flatMap(goal => goal.tasks)
    const rows = board.goals.map(goal => {
      const taskRows = goal.tasks.map(task => {
        const status = task.status === 'running' && !board.running.includes(task.id)
          ? 'Running status unverified' : statusText(task.status)
        const details = []
        if (task.progress) details.push(`Last progress (${displayDate(task.progress.at)}): ${task.progress.text}`)
        if (task.updated) details.push(`Updated: ${displayDate(task.updated)}`)
        if (task.workspace) details.push(`Workspace: ${task.workspace}${task.archived ? ' (may have been cleaned up)' : ''}`)
        for (const artifact of task.result?.artifacts ?? []) {
          const path = typeof artifact === 'string' ? artifact : artifact.path
          if (path) details.push(`Result: ${path}`)
        }
        return record(task.title, `${status}${task.archived ? ' / archived' : ''}`,
          [task.summary, task.remote ? `Remote endpoint: ${task.remote.endpointId}` : null].filter((line): line is string => Boolean(line)), details)
      })
      return `<li class="startup-report-goal"><h3>${escapeHtml(goal.title)} <span>${escapeHtml(statusText(goal.status))}</span></h3>${goal.notes ? `<p>${escapeHtml(goal.notes)}</p>` : ''}${taskRows.length ? `<ul class="startup-report-list">${taskRows.join('')}</ul>` : '<p>No worker tasks recorded.</p>'}</li>`
    })
    section('Background Work', `${board.goals.length} goals / ${tasks.length} tasks / ${board.running.length} running workers`, rows)
    if (board.approvals.length) section('Pending Approvals', `${board.approvals.length} awaiting your decision`, board.approvals.map(approval => record(approval.action, 'Awaiting approval', [approval.detail])))
  }
  if (snapshot.schedules) {
    section('Scheduled Work', `${snapshot.schedules.length} schedules; separate from running workers`, snapshot.schedules.map(saved => {
      const schedule = { ...saved, ...board?.schedules?.find(item => item.id === saved.id) }
      const details = []
      if (schedule.lastRunAt) details.push(`Last launched: ${displayDate(schedule.lastRunAt)}`)
      if (schedule.lastStatus) details.push(`Last goal: ${statusText(schedule.lastStatus)}`)
      if (schedule.lastSummary) details.push(`Last result: ${schedule.lastSummary}`)
      return record(schedule.title, statusText(schedule.status), [describeTrigger(schedule.trigger), `Next run: ${schedule.nextRunAt ? displayDate(schedule.nextRunAt) : 'None'}`, ...(schedule.error ? [`Error: ${schedule.error}`] : [])], details)
    }))
  }
  if (snapshot.sessionAgents) section('Session Subagents', `${snapshot.sessionAgents.length} retained records`, snapshot.sessionAgents.map(agent => {
    const status = agent.status === 'running' && !agent.live ? 'Saved running status / unverified' : statusText(agent.status)
    return record(agent.title, status, [agent.live ? 'Tracked by a current bridge session' : 'Saved history; not a live worker'], agent.summary ? [agent.summary] : [])
  }))
  if (snapshot.capacity) section('Agent Endpoints', 'Last health checks reported by the service', snapshot.capacity.endpoints.map(endpoint => record(endpoint.label || endpoint.id, endpoint.healthy ? 'Healthy' : 'Unavailable', [`${endpoint.kind} / ${endpoint.running} running workers`])))
  if (snapshot.memory) {
    const rows = (snapshot.memory.tasks ?? []).map(task => record(task.text, 'Open'))
    for (const goal of snapshot.memory.goals ?? []) rows.push(record(goal, 'Personal goal'))
    section('Personal Work', snapshot.memory.focus ? `Current focus: ${snapshot.memory.focus}` : `${snapshot.memory.tasks?.length ?? 0} open tasks`, rows)
    const progress = (snapshot.memory.log ?? []).slice(-10)
    if (progress.length) sections.push(`<details class="startup-report-history"><summary>Recent Recorded Progress</summary><ul>${progress.map(item => `<li>${escapeHtml(`${item.date ? `${item.date}: ` : ''}${item.text}`)}</li>`).join('')}</ul></details>`)
  }
  if (snapshot.looseEnds) {
    const open = snapshot.looseEnds.items.filter(item => item.status !== 'done')
    section('Unfinished Work', `${open.length} open assistant items`, open.map(item => record(item.action, item.status, item.project ? [item.project] : [], item.state ? [item.state] : [])))
  }
  if (snapshot.errors.length) section('Unverified Sources', 'These sources could not be checked; their work is not assumed empty.', snapshot.errors.map(error => record(error.source, 'Unknown', [error.message])))
  return `<div class="startup-report"><p class="startup-report-overview">${escapeHtml(summarizeStartupStatus(snapshot))}</p><p class="startup-report-meta">Checked ${escapeHtml(displayDate(snapshot.observedAt))}</p>${sections.join('')}</div>`
}

export function summarizeStartupStatus(snapshot: StartupSnapshot): string {
  const board = snapshot.board
  const tasks = board?.goals.flatMap(goal => goal.tasks) ?? []
  const liveSubagents = snapshot.sessionAgents?.filter(agent => agent.live && agent.status === 'running').length ?? 0
  const running = (board?.running.length ?? 0) + liveSubagents
  const lines = [board
    ? running ? `${running} agent${running === 1 ? ' is' : 's are'} running.` : 'No agents are currently reported running.'
    : 'Background agent status could not be verified.']
  const schedules = snapshot.schedules?.filter(schedule => schedule.status === 'active').length ?? 0
  const outstanding = (snapshot.memory?.tasks?.length ?? 0) +
    (snapshot.looseEnds?.items.filter(item => item.status !== 'done').length ?? 0)
  if (schedules || outstanding) {
    lines.push(`${schedules} active schedule${schedules === 1 ? '' : 's'} and ${outstanding} outstanding item${outstanding === 1 ? '' : 's'} are recorded.`)
  }
  const blocked = tasks.filter(task => ['blocked', 'failed', 'awaiting_approval'].includes(task.status) && !task.archived).length
  const approvals = board?.approvals.length ?? 0
  const unhealthy = snapshot.capacity?.endpoints.filter(endpoint => !endpoint.healthy).length ?? 0
  const issues = []
  if (blocked) issues.push(`${blocked} task${blocked === 1 ? '' : 's'} needing attention`)
  if (approvals) issues.push(`${approvals} pending approval${approvals === 1 ? '' : 's'}`)
  if (unhealthy) issues.push(`${unhealthy} unavailable endpoint${unhealthy === 1 ? '' : 's'}`)
  if (snapshot.errors.length) issues.push(`${snapshot.errors.length} unverified source${snapshot.errors.length === 1 ? '' : 's'}`)
  if (issues.length) lines.push(`There ${issues.length === 1 && issues[0].startsWith('1 ') ? 'is' : 'are'} ${issues.join(', ')}.`)
  lines.push('The full report is on screen.')
  return lines.join(' ')
}

export function formatStartupStatus(snapshot: StartupSnapshot): string {
  const lines = [`Startup work report. Snapshot: ${snapshot.observedAt}.`]
  const board = snapshot.board
  if (board) {
    const tasks = board.goals.flatMap(goal => goal.tasks)
    lines.push(`Background work: ${board.goals.length} goals, ${tasks.length} tasks; ${board.running.length} workers reported running.`)
    for (const goal of board.goals) {
      lines.push(`${goal.title}: ${statusText(goal.status)}.${goal.notes ? ` ${goal.notes}` : ''}`)
      if (!goal.tasks.length) lines.push('No worker tasks recorded for this goal.')
      for (const task of goal.tasks) {
        const running = task.status === 'running' && !board.running.includes(task.id)
          ? 'recorded as running, but no live worker is reported' : statusText(task.status)
        lines.push(`${task.title}: ${running}${task.remote ? ` on remote endpoint ${task.remote.endpointId}` : ''}${task.archived ? ' (archived)' : ''}.${task.summary ? ` ${task.summary}` : ''}`)
        if (task.progress) lines.push(`Last recorded progress at ${task.progress.at}: ${task.progress.text}`)
        if (task.updated) lines.push(`Task last updated: ${task.updated}.`)
        if (task.workspace) lines.push(`Recorded workspace: ${task.workspace}${task.archived ? ' (may have been cleaned up)' : ''}`)
        for (const artifact of task.result?.artifacts ?? []) {
          const path = typeof artifact === 'string' ? artifact : artifact.path
          if (path) lines.push(`Result: ${path}`)
        }
      }
    }
    for (const approval of board.approvals) lines.push(`Approval waiting: ${approval.action}. ${approval.detail}`)
  }
  if (snapshot.schedules) {
    lines.push(`Scheduled work: ${snapshot.schedules.length} schedules. Schedules are not running agents.`)
    for (const saved of snapshot.schedules) {
      const schedule = { ...saved, ...board?.schedules?.find(item => item.id === saved.id) }
      lines.push(`${schedule.title}: ${statusText(schedule.status)}, ${describeTrigger(schedule.trigger)}. Next run: ${schedule.nextRunAt ?? 'none'}.`)
      if (schedule.lastRunAt) lines.push(`Last launched: ${schedule.lastRunAt}. Last goal: ${schedule.lastStatus ?? 'not available'}.${schedule.lastSummary ? ` ${schedule.lastSummary}` : ''}`)
      if (schedule.error) lines.push(`Schedule error: ${schedule.error}`)
    }
  }
  if (snapshot.sessionAgents) {
    lines.push(`Session subagents: ${snapshot.sessionAgents.length} retained records.`)
    for (const agent of snapshot.sessionAgents) {
      const status = agent.status === 'running' && !agent.live ? 'saved running status, not verified live' : statusText(agent.status)
      lines.push(`${agent.title}: ${status}${agent.live ? ', tracked by a current bridge session' : ', saved history'}.${agent.summary ? ` ${agent.summary}` : ''}`)
    }
  }
  if (snapshot.capacity) {
    lines.push('Agent endpoints, as last reported by the service:')
    for (const endpoint of snapshot.capacity.endpoints) {
      lines.push(`${endpoint.label || endpoint.id} (${endpoint.kind}): ${endpoint.healthy ? 'last health check passed' : 'unhealthy or unavailable'}, ${endpoint.running} running workers.`)
    }
  }
  if (snapshot.memory) {
    if (snapshot.memory.focus) lines.push(`Current focus: ${snapshot.memory.focus}`)
    for (const goal of snapshot.memory.goals ?? []) lines.push(`Personal goal: ${goal}`)
    lines.push(`Personal tasks: ${snapshot.memory.tasks?.length ?? 0} open.`)
    for (const task of snapshot.memory.tasks ?? []) lines.push(`To do: ${task.text}`)
    for (const item of (snapshot.memory.log ?? []).slice(-10)) lines.push(`Recorded progress${item.date ? ` ${item.date}` : ''}: ${item.text}`)
  }
  if (snapshot.looseEnds) {
    const open = snapshot.looseEnds.items.filter(item => item.status !== 'done')
    lines.push(`Unfinished assistant work: ${open.length} items.`)
    for (const item of open) lines.push(`${item.project ? `${item.project}: ` : ''}${item.action} (${item.status}).${item.state ? ` ${item.state}` : ''}`)
  }
  for (const error of snapshot.errors) lines.push(`Could not verify ${error.source}: ${error.message}`)
  return lines.join('\n')
}