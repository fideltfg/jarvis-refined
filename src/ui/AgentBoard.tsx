import { useStore, type AgentTask } from '../store'
import { decideApproval } from '../lib/brain'

/**
 * The agent board: one card per goal, one row per task. It opens by itself
 * while agents are working or waiting on the user, and on the A key; with
 * nothing happening it stays out of the way. Colours come from the theme's
 * accent so every theme styles it without its own rules.
 */

const LABEL: Record<AgentTask['status'], string> = {
  queued: 'queued',
  running: 'running',
  blocked: 'blocked',
  awaiting_approval: 'approval',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

export function AgentBoard() {
  const board = useStore((s) => s.agentBoard)
  const online = useStore((s) => s.agentsOnline)
  const seen = useStore((s) => s.agentsSeen)
  const open = useStore((s) => s.boardOpen)

  if (!seen) return null
  const active = board?.goals.some((g) => g.tasks.some((t) => t.status === 'running' || t.status === 'awaiting_approval')) ?? false
  if (!open && !active) return null

  return (
    <div className="agent-board" role="region" aria-label="Agent board">
      <div className="ab-head">
        AGENTS{!online && <span className="ab-offline"> · offline</span>}
      </div>
      {!online && <div className="ab-empty">The agent service is offline.</div>}
      {online && board && !board.goals.length && <div className="ab-empty">No goals in progress.</div>}
      {online &&
        board?.goals.map((g) => {
          const live = g.tasks.filter((t) => t.status !== 'cancelled')
          const done = live.filter((t) => t.status === 'done').length
          return (
            <section key={g.id} className="ab-goal" data-status={g.status}>
              <div className="ab-goal-title">
                {g.title}
                {g.status === 'paused' && <span className="ab-paused"> · paused</span>}
              </div>
              <div className="ab-bar">
                <span style={{ width: `${live.length ? (done / live.length) * 100 : 0}%` }} />
              </div>
              <ul className="ab-tasks">
                {live.map((t) => {
                  const pending = board.approvals.find((a) => a.taskId === t.id)
                  return (
                    <li key={t.id} className="ab-task">
                      <span className={`ab-chip ab-chip-${t.status}`}>{LABEL[t.status]}</span>
                      <span className="ab-task-title">{t.title}</span>
                      {pending && (
                        <span className="ab-actions">
                          <span className="ab-ask">{pending.action}</span>
                          <button type="button" onClick={() => decideApproval(pending.id, 'approve')}>Approve</button>
                          <button type="button" onClick={() => decideApproval(pending.id, 'deny')}>Deny</button>
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
    </div>
  )
}
