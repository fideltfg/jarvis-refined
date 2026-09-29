import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromeServer } from '../bridge/chrome.mjs'
import { createApi } from './api.mjs'
import { createApprovals } from './approvals.mjs'
import { AGENTS_DIR, PORT, TOKEN } from './config.mjs'
import { createContacts } from './contacts.mjs'
import { createCoordinator, sdkModel } from './coordinator.mjs'
import { paMirror } from './mirror.mjs'
import { recover } from './recover.mjs'
import { createScheduler } from './scheduler.mjs'
import { createStore } from './store.mjs'
import { runTask } from './worker.mjs'
import { cleanupWorkspaces } from './workspace.mjs'

/**
 * jarvis-agents: goals, a coordinator and background workers, as its own
 * process so that restarting JARVIS (which every theme change does) never
 * interrupts an agent mid-step.
 */

/** The MCP servers Claude Code has configured, as the bridge reads them. */
function externalServers() {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))
    return { ...(cfg.mcpServers ?? {}), ...(cfg.projects?.[homedir()]?.mcpServers ?? {}) }
  } catch {
    return {}
  }
}

const store = createStore(AGENTS_DIR)
const contacts = createContacts(join(AGENTS_DIR, 'contacts.json'))
const approvals = createApprovals(store, { contacts })
const mirror = paMirror()
const coordinator = createCoordinator({ store, runModel: sdkModel(), mirror })
const external = externalServers()

const mcpFor = (task) => {
  if (task.kind === 'ops') return external
  if (task.kind === 'admin') return { ...external, jarvis_chrome: chromeServer({ allowWrites: true }) }
  return {}
}

const scheduler = createScheduler({
  store,
  coordinator,
  onCancel: (taskId) => approvals.expire(taskId),
  runTask: (task, opts) =>
    runTask(task, { ...opts, store, approvals, contacts: () => contacts.get(), mcpServers: mcpFor(task) }),
})

const recovered = recover(store, approvals)
const api = createApi({
  store, scheduler, coordinator, approvals, mirror,
  cleanup: () => cleanupWorkspaces(store),
  token: TOKEN,
  port: PORT,
})

const port = await api.listen()
scheduler.start()
console.log(`[agents] listening on 127.0.0.1:${port} · state in ${AGENTS_DIR} · ${recovered} task(s) recovered`)

const shutdown = async () => {
  scheduler.stop()
  await api.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
