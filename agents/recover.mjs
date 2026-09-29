/**
 * After a restart, nothing is actually running. Tasks left as running go back
 * to the queue and resume their SDK session; anything that was waiting on an
 * approval expired with its worker and will ask again when it resumes.
 */
export function recover(store, approvals) {
  approvals.expire()
  let count = 0
  for (const t of store.listTasks()) {
    if (t.status !== 'running' && t.status !== 'awaiting_approval') continue
    store.saveTask({ ...t, status: 'queued', resume: Boolean(t.sessionId) })
    store.appendEvent({ type: 'task_queued', goalId: t.goalId, taskId: t.id, text: `Resuming after a restart: ${t.title}`, data: { title: t.title } })
    count++
  }
  return count
}
