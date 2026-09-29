import { useStore, type AgentTask } from '../store'
import { decideApproval } from '../lib/brain'

/**
 * The agent board: every agent JARVIS has running, in one view.
 *
 * Two kinds of agent reach it. The agent service contributes goals, each with
 * its tasks and any approval it is waiting on. The voice session contributes
 * the subagents a turn dispatches, which belong to no goal and finish within
 * the turn. They are listed apart because their lifecycles differ, but on one
 * board, because "what are your agents doing" is one question.
 *
 * It opens by itself while anything is working or waiting on the user, and on
 * the A key; with nothing happening it stays out of the way. Colours come from
 * the theme's accent so every theme styles it without its own rules.
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
  const session = useStore((s) => s.sessionAgents)

  // Subagents alone are reason enough to have a board: the agent service can be
  // switched off entirely and a turn can still dispatch one.
  if (!seen && !session.length) return null
  const goalsActive = board?.goals.some((g) => g.tasks.some((t) => t.status === 'running' || t.status === 'awaiting_approval')) ?? false
  const sessionActive = session.some((a) => a.status === 'running')
  if (!open && !goalsActive && !sessionActive) return null

  return (
    <div className="agent-board" role="region" aria-label="Agent board">
      <div className="ab-head">
        AGENTS{seen && !online && <span className="ab-offline"> · offline</span>}
      </div>
      {seen && !online && <div className="ab-empty">The agent service is offline.</div>}
      {online && board && !board.goals.length && !session.length && <div className="ab-empty">No goals in progress.</div>}
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
      {session.length > 0 && (
        <section className="ab-goal ab-session">
          <div className="ab-goal-title">This session</div>
          <ul className="ab-tasks">
            {session.map((a) => (
              <li key={a.id} className="ab-task">
                <span className={`ab-chip ab-chip-${a.status}`}>{a.status}</span>
                <span className="ab-task-title">{a.title}</span>
                <span className="ab-kind">{a.kind}</span>
                {a.summary && <span className="ab-summary">{a.summary}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
