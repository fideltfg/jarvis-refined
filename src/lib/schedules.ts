export type ScheduleTrigger =
  | { type: 'once'; at: string }
  | { type: 'interval'; minutes: number; startAt?: string }
  | { type: 'daily'; time: string; timezone: string }
  | { type: 'weekly'; time: string; timezone: string; days: number[] }

export type ScheduleInput = { title: string; outcome: string; priority: number; trigger: ScheduleTrigger }
export type Schedule = ScheduleInput & {
  id: string
  status: 'active' | 'paused' | 'completed' | 'deleted'
  nextRunAt: string | null
  lastRunAt: string | null
  lastGoalId: string | null
  pendingOccurrence?: unknown
  error: string | null
  lastStatus?: string | null
  lastSummary?: string | null
}
export type ScheduleRequest =
  | { action: 'list' }
  | { action: 'create'; input: ScheduleInput }
  | { action: 'update'; id: string; change: { action: 'edit' | 'pause' | 'resume' | 'delete'; values?: Partial<ScheduleInput> } }
  | { action: 'run'; id: string }

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function describeTrigger(trigger: ScheduleTrigger) {
  if (trigger.type === 'once') return 'One time'
  if (trigger.type === 'interval') return `Every ${trigger.minutes % 1440 === 0 ? `${trigger.minutes / 1440} days` : trigger.minutes % 60 === 0 ? `${trigger.minutes / 60} hours` : `${trigger.minutes} minutes`}`
  return `${trigger.type === 'daily' ? 'Daily' : trigger.days.map((day) => WEEKDAYS[day]).join(', ')} at ${trigger.time} · ${trigger.timezone}`
}

export function localDateTime(instant: string) {
  const date = new Date(instant)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function onceFromLocal(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a date and time.')
  const date = new Date(value)
  if (!Number.isFinite(+date) || localDateTime(date.toISOString()) !== value) throw new Error('That local time does not exist. Choose another time.')
  for (const direction of [-1, 1]) {
    const adjacent = new Date(+date + direction * 86400000)
    const alternative = new Date(+date + (adjacent.getTimezoneOffset() - date.getTimezoneOffset()) * 60000)
    if (+alternative !== +date && localDateTime(alternative.toISOString()) === value) throw new Error('That local time occurs twice during daylight-saving change. Choose an unambiguous time.')
  }
  return date.toISOString()
}