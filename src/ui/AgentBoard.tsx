import { useMemo } from 'react'

import { useStore } from '../store'
import { decideApproval } from '../lib/brain'
import { ago, capacityLine, mergeBoard, statusLabel, type BoardAgent } from '../lib/board'

/**
 * The agent board: every agent JARVIS has running, in one view.
 *
 * Two kinds of agent reach it — the agent service's goals and tasks, and the
 * subagents a voice turn dispatches — and they used to be drawn as two
 * sections, which made "what are your agents doing" two questions with two
 * answers. They are one list now. Every row carries the same four things: what
 * it is called, what state it is in, what it is doing and what came of it, plus
 * a tag saying which kind of agent it is. The merge and the ordering live in
 * lib/board; this only draws rows.
 *
 * It opens by itself while anything is working or waiting on the user, and on
 * the A key; with nothing happening it stays out of the way. Colours come from
 * the theme's accent so every theme styles it without its own rules.
 */

const KIND_LABEL: Record<BoardAgent['kind'], string> = {
  goal: 'goal',
  task: 'task',
  subagent: 'subagent',
}

/** Anything the user could still act on, and so a reason to open the board. */
const LIVE: BoardAgent['status'][] = ['running', 'awaiting_approval', 'blocked']

export function AgentBoard() {
  const board = useStore((s) => s.agentBoard)
  const online = useStore((s) => s.agentsOnline)
  const seen = useStore((s) => s.agentsSeen)
  const open = useStore((s) => s.boardOpen)
  const session = useStore((s) => s.sessionAgents)

  // The service being offline must not hide a subagent: a turn can dispatch one
  // with the agent service switched off entirely.
  const rows = useMemo(() => mergeBoard(online ? board : null, session), [board, online, session])
  const capacity = online ? (board?.capacity ?? null) : null
  const pool = capacityLine(capacity)

  // Subagents alone are reason enough to have a board.
  if (!seen && !session.length) return null
  if (!open && !rows.some((r) => LIVE.includes(r.status))) return null

  return (
    <div className="agent-board" role="region" aria-label="Agent board">
      <div className="ab-head">
        AGENTS{seen && !online && <span className="ab-offline"> · offline</span>}
      </div>
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
      {!rows.length && online && <div className="ab-empty">Nothing in progress.</div>}
      <ul className="ab-list">
        {rows.map((row) => (
          <li key={`${row.kind}-${row.id}`} className="ab-row" data-kind={row.kind} data-nested={row.parentId ? '' : undefined}>
            <span className="ab-line">
              <span className={`ab-chip ab-chip-${row.status}`}>{statusLabel(row.status)}</span>
              <span className="ab-name">{row.name}</span>
              <span className="ab-kind">{KIND_LABEL[row.kind]}</span>
              {/* History outlives the session now, so a row has to say when. */}
              {ago(row.finishedAt ?? row.startedAt) && (
                <span className="ab-when">{ago(row.finishedAt ?? row.startedAt)}</span>
              )}
            </span>
            {row.progress !== null && (
              <span className="ab-bar">
                <span style={{ width: `${row.progress * 100}%` }} />
              </span>
            )}
            {row.activity && <span className="ab-activity">{row.activity}</span>}
            {row.result && <span className="ab-result">{row.result}</span>}
            {row.approval && (
              <span className="ab-actions">
                <span className="ab-ask">{row.approval.action}</span>
                <button type="button" onClick={() => decideApproval(row.approval!.id, 'approve')}>Approve</button>
                <button type="button" onClick={() => decideApproval(row.approval!.id, 'deny')}>Deny</button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
