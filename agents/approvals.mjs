/**
 * Hard-stop requests. A worker's gate awaits request(); the user answers by
 * voice or on the board through decide(). The record is on disk so the board
 * and a briefing can show it; the promise lives only in this process, so a
 * restart expires whatever was waiting and the resumed worker asks again.
 */
export function createApprovals(store, { contacts = null } = {}) {
  const waiters = new Map()

  return {
    /** Persist an approval request and suspend the worker until it is decided. */
    request({ task, category, action, detail, recipients = [] }) {
      const a = store.newApproval({ taskId: task.id, category, action, detail, recipients })
      const current = store.getTask(task.id)
      if (current) store.saveTask({ ...current, status: 'awaiting_approval' })
      store.appendEvent({
        type: 'approval_needed',
        goalId: task.goalId,
        taskId: task.id,
        text: `Approval needed: ${action}`,
        data: { approvalId: a.id, category, action, detail, title: task.title },
      })
      return new Promise((resolve) => {
        // Keep only the in-process resolver; the pending approval itself is durable.
        waiters.set(a.id, resolve)
      })
    },

    /** Validate and persist a user decision, then resume or deny the waiting worker. */
    decide(id, decision, note = null) {
      if (decision !== 'approve' && decision !== 'deny') throw new Error('The decision must be approve or deny.')
      const a = store.getApproval(id)
      if (!a) throw new Error(`No approval ${id}.`)
      if (a.status !== 'pending') throw new Error(`Approval ${id} is already ${a.status}.`)
      const approved = decision === 'approve'
      const saved = store.saveApproval({ ...a, status: approved ? 'approved' : 'denied', note, decided: new Date().toISOString() })
      if (approved && a.category === 'new_contact' && a.recipients?.length) contacts?.add(a.recipients)
      const task = store.getTask(a.taskId)
      if (task?.status === 'awaiting_approval') store.saveTask({ ...task, status: 'running' })
      store.appendEvent({
        type: 'approval_decided',
        goalId: task?.goalId,
        taskId: a.taskId,
        text: `${approved ? 'Approved' : 'Denied'}: ${a.action}`,
        data: { approvalId: id },
      })
      waiters.get(id)?.({ approved, note })
      waiters.delete(id)
      return saved
    },

    /** Expire pending requests for a task, or all pending requests after restart. */
    expire(taskId) {
      for (const a of store.listApprovals('pending')) {
        if (taskId && a.taskId !== taskId) continue
        store.saveApproval({ ...a, status: 'expired', decided: new Date().toISOString() })
        waiters.get(a.id)?.({ approved: false, note: 'The request expired.' })
        waiters.delete(a.id)
      }
    },
  }
}
