import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromeServer } from '../bridge/chrome.mjs'
import { createHealth } from '../bridge/endpoints.mjs'
import { createApi } from './api.mjs'
import { createApprovals } from './approvals.mjs'
import { AGENTS_DIR, HOST, MAX_WORKERS, PORT, TOKEN, tlsOptions } from './config.mjs'
import { createContacts } from './contacts.mjs'
import { createCoordinator, sdkModel } from './coordinator.mjs'
import { createDispatch } from './dispatch.mjs'
import { paMirror } from './mirror.mjs'
import { agentEndpoints, createPool } from './pool.mjs'
import { recover } from './recover.mjs'
import { createScheduler } from './scheduler.mjs'
import { createStore } from './store.mjs'
import { cleanupWorkspaces, removeWorkspace } from './workspace.mjs'

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

/**
 * Capacity, counted per endpoint. JARVIS_MAX_WORKERS is the ceiling across the
 * whole pool — a generous endpoint list must not be able to spawn more workers
 * than this box can bear — and the health memory keeps the scheduler from
 * waiting on a machine that is switched off.
 */
const endpoints = agentEndpoints()
const health = createHealth()
const maxTotal = Number(process.env.JARVIS_MAX_WORKERS) || Math.max(MAX_WORKERS, endpoints.reduce((t, e) => t + e.concurrency, 0))
const pool = createPool({ endpoints, health, maxTotal })

const dispatch = createDispatch({
  store,
  health,
  localDeps: (task) => ({ approvals, contacts: () => contacts.get(), mcpServers: mcpFor(task) }),
})

const scheduler = createScheduler({
  store,
  coordinator,
  mirror,
  pool,
  maxWorkers: pool.capacity(),
  onCancel: (taskId) => approvals.expire(taskId),
  onArchive: (task) => removeWorkspace(task),
  runTask: dispatch,
})

const probeAll = () =>
  health.checkAll(endpoints, { force: true }).catch((err) => console.warn('[agents] endpoint probe failed:', err.message))
probeAll()

const probeTimer = setInterval(probeAll, 60_000)
probeTimer.unref()

const recovered = recover(store, approvals)
const api = createApi({
  store, scheduler, coordinator, approvals, mirror, pool,
  cleanup: () => cleanupWorkspaces(store),
  token: TOKEN,
  host: HOST,
  port: PORT,
  tls: tlsOptions(),
})

const port = await api.listen()
scheduler.start()
const capacity = `${pool.capacity()} slot(s) across ${endpoints.length} endpoint(s): ${endpoints.map((e) => `${e.id}×${e.concurrency}`).join(', ')}`
const door = `${api.tls ? 'https' : 'http'}://${HOST}:${port}`
console.log(`[agents] listening on ${door} · state in ${AGENTS_DIR} · ${recovered} task(s) recovered · ${capacity}`)

const shutdown = async () => {
  clearInterval(probeTimer)
  scheduler.stop()
  await api.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
