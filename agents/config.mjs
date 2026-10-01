import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Everything the agent service is tuned by, in one place. Paths and the port
 * can be overridden from the environment so tests and a second instance never
 * touch the real state.
 */
export const AGENTS_DIR =
  process.env.JARVIS_AGENTS_DIR || join(homedir(), '.config', 'jarvis', 'agents')
export const WORK_DIR = process.env.JARVIS_WORK_DIR || join(homedir(), '.jarvis-work')
export const PORT = Number(process.env.JARVIS_AGENTS_PORT) || 8788
export const TOKEN = process.env.JARVIS_AGENTS_TOKEN || ''

/**
 * The kinds of obstacle a blocked agent may name. The coordinator routes on
 * these, so the list is deliberately short and an agent that fits none of them
 * names none: unspecified is a real answer, a wrong code is not.
 */
export const BLOCKERS = ['approval', 'credential', 'decision', 'dependency', 'upstream']

export const MAX_WORKERS = 3
export const MAX_ATTEMPTS = 3
export const DEFAULT_TASK_CAP = 20

export const MODELS = {
  sonnet: process.env.JARVIS_AGENTS_SONNET || 'claude-sonnet-5',
  opus: process.env.JARVIS_AGENTS_OPUS || 'claude-opus-5',
}

export const BUDGETS = {
  code: { maxTurns: 60, maxMinutes: 45, maxUsd: 5 },
  research: { maxTurns: 30, maxMinutes: 20, maxUsd: 3 },
  ops: { maxTurns: 40, maxMinutes: 30, maxUsd: 3 },
  admin: { maxTurns: 30, maxMinutes: 20, maxUsd: 3 },
}

export const KINDS = Object.keys(BUDGETS)
