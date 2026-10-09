import { createRemoteApi } from './api.mjs'
import { createApprovals } from '../agents/approvals.mjs'
import { AGENTS_DIR, HOST, PORT, TOKEN, tlsOptions } from '../agents/config.mjs'
import { createPool } from '../agents/pool.mjs'
import { recover } from '../agents/recover.mjs'
import { createScheduler } from '../agents/scheduler.mjs'
import { createStore } from '../agents/store.mjs'
import { localModelURL, runTask } from './worker.mjs'

const modelURL = localModelURL(process.env.JARVIS_REMOTE_MODEL_URL)
const model = process.env.JARVIS_REMOTE_MODEL
if (!model) throw new Error('JARVIS_REMOTE_MODEL is required.')
const workers = Math.max(1, Math.min(8, Number(process.env.JARVIS_REMOTE_WORKERS) || 1))
const store = createStore(AGENTS_DIR)
const approvals = createApprovals(store)
const pool = createPool({ endpoints: [{ id: 'local-model', kind: 'local', model,
  concurrency: workers, kinds: ['research', 'ops'], weight: 1 }], maxTotal: workers })
// Remote hosts execute already-planned tasks and do not coordinate new plans.
const scheduler = createScheduler({ store, pool, coordinator: { review: async () => {} },
  // Expire an outstanding approval when its delegated task is cancelled.
  onCancel: (id) => approvals.expire(id),
  // Run each accepted task against this host's configured local model.
  runTask: (task, { signal }) => runTask(task, { store, signal, modelURL, model }) })
const recovered = recover(store, approvals)
const api = createRemoteApi({ store, scheduler, approvals, token: TOKEN, host: HOST, port: PORT, tls: tlsOptions() })
const port = await api.listen()
scheduler.start()
console.log(`[remote-agent] listening on ${api.tls ? 'https' : 'http'}://${HOST}:${port}; ${recovered} recovered`)
/** Stop scheduling work and close the API during process shutdown. */
async function shutdown() {
  scheduler.stop()
  await api.close()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
