import { runRemoteTask } from './remote.mjs'
import { runTask as runWorkerTask } from './worker.mjs'

/**
 * Route a leased task to a local worker or a remote agent service. Remote
 * work is limited to research and ops; the receiving host applies its own
 * safety gate and budget ceiling.
 */

export const isRemote = (endpoint) => endpoint?.kind === 'remote'

export function createDispatch({
  store,
  health = null,
  localDeps = () => ({}),
  local = runWorkerTask,
  remote = runRemoteTask,
  remoteDeps = {},
}) {
  const remember = (taskId, handle) => {
    const current = store.getTask(taskId)
    if (!current) return
    if (!handle && !current.remote) return
    store.saveTask({ ...current, remote: handle ?? null })
  }

  return function dispatch(task, opts = {}) {
    const endpoint = opts.endpoint ?? null
    const current = store.getTask(task.id) ?? task
    if (current.remote && (!isRemote(endpoint) || endpoint.id !== current.remote.endpointId)) {
      return { status: 'failed', failure: { reason: 'remote', detail: `Task already delegated to ${current.remote.endpointId}; cannot dispatch elsewhere.` } }
    }
    if (isRemote(endpoint) && (current.kind !== 'research' && current.kind !== 'ops' || current.delegated)) {
      return { status: 'failed', failure: { reason: 'remote', detail: 'Only originating research and ops tasks may travel.' } }
    }
    if (!isRemote(endpoint)) return local(current, { ...localDeps(current), ...opts, store })
    return remote(current, {
      ...remoteDeps,
      signal: opts.signal,
      store,
      endpoint,
      onRemote: (handle) => remember(task.id, handle),
      onLost: () => health?.mark(endpoint.id, false),
    })
  }
}
