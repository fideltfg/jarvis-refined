import { listEndpoints } from '../bridge/endpoints.mjs'
import { MAX_WORKERS, MODELS } from './config.mjs'

/**
 * Capacity, counted per machine instead of once for everything.
 *
 * The scheduler used to stop at a fixed number of running workers. It now asks
 * here for a lease, and a lease names the endpoint the work will run on — so
 * four modest boxes at two jobs each carry eight tasks, and one saturated host
 * no longer holds up the whole queue.
 *
 * Only anthropic, gateway and remote endpoints can run a local agent task: the worker
 * drives the Claude Agent SDK, which speaks the Anthropic API and nothing else.
 * An OpenAI-compatible box serves conversation and cheap summarising through
 * bridge/providers.mjs; it cannot carry a task, because the safety gate lives in
 * the SDK's hooks and would not exist there. A remote endpoint carries a task by
 * not running it here at all — the whole task goes to another host's service,
 * which applies its own gate. The standalone remote runtime also uses an
 * internal `local` pool entry for its text-only OpenAI-compatible worker.
 */

export const TASK_KINDS_ALL = null

const CARRIERS = ['anthropic', 'gateway', 'remote']

/** The endpoints an agent task may run on, defaulting to today's behaviour. */
export function agentEndpoints(env = process.env) {
  const usable = listEndpoints(env).filter((endpoint) => CARRIERS.includes(endpoint.kind))
  if (usable.length) return usable
  return [{
    id: 'anthropic',
    kind: 'anthropic',
    baseURL: null,
    model: null,
    apiKeyEnv: null,
    concurrency: MAX_WORKERS,
    kinds: [],
    weight: 1,
    label: 'Anthropic',
  }]
}

/** Whether a task may name this as its model: a size, or an endpoint id. */
export function isTaskModel(model, env = process.env) {
  if (!model) return false
  if (Object.hasOwn(MODELS, model)) return true
  return agentEndpoints(env).some((endpoint) => endpoint.id === model)
}

export function taskModels(env = process.env) {
  return [...Object.keys(MODELS), ...agentEndpoints(env).map((endpoint) => endpoint.id)]
}

/**
 * A size names a machine that can resolve it: this process's own Anthropic
 * credentials, or another host's service, which looks the size up in its own
 * config. A gateway cannot — it serves one named model — so it has to be asked
 * for by id.
 */
const matchesModel = (endpoint, model) => {
  if (!model || Object.hasOwn(MODELS, model)) return endpoint.kind === 'anthropic' || endpoint.kind === 'remote' || endpoint.kind === 'local'
  return endpoint.id === model
}

const matchesKind = (endpoint, kind) => !endpoint.kinds.length || !kind || endpoint.kinds.includes(kind)

/**
 * Two things never leave this machine, whatever the endpoint list says. A code
 * task's worktree, repository and policy allow-list are local paths, and an
 * admin task acts through the user's own signed-in browser. And a task that
 * arrived here delegated is never delegated onward: two hosts pointing at each
 * other would otherwise pass the same work back and forth for ever.
 */
const canCarry = (endpoint, task) =>
  endpoint.kind !== 'remote' || (!task.delegated && (!task.remote || task.remote.endpointId === endpoint.id) &&
    (task.kind === 'research' || task.kind === 'ops'))

/**
 * @param endpoints what work may run on
 * @param health    optional bridge/endpoints createHealth; unprobed is healthy
 * @param maxTotal  a global ceiling across the pool, so a generous list of
 *                  endpoints cannot spawn more workers than the box can bear
 */
export function createPool({ endpoints = agentEndpoints(), health = null, maxTotal = Number.POSITIVE_INFINITY } = {}) {
  const live = new Map()
  const inFlight = () => [...live.values()].reduce((total, n) => total + n, 0)
  const load = (endpoint) => live.get(endpoint.id) ?? 0
  const usable = (endpoint) => !health || health.healthy(endpoint.id)
  const free = (endpoint) => load(endpoint) < endpoint.concurrency

  const eligible = (task = {}) =>
    endpoints.filter((endpoint) =>
      usable(endpoint) && (!task.remote || (endpoint.kind === 'remote' && endpoint.id === task.remote.endpointId)) &&
      canCarry(endpoint, task) && matchesModel(endpoint, task.model) && matchesKind(endpoint, task.kind))

  /** Least loaded relative to its own size, then by weight, then by id: no
   *  clocks and no randomness, so the choice is the same in a test twice. */
  const order = (a, b) =>
    load(a) / a.concurrency - load(b) / b.concurrency ||
    b.weight - a.weight ||
    a.id.localeCompare(b.id)

  return {
    endpoints: () => endpoints.map((endpoint) => ({ ...endpoint })),

    capacity: () => Math.min(maxTotal, endpoints.reduce((total, endpoint) => total + endpoint.concurrency, 0)),

    inFlight,

    /** Is there room for anything at all, whatever it is pinned to. */
    free: () => inFlight() < maxTotal && endpoints.some((endpoint) => usable(endpoint) && free(endpoint)),

    /** A lease naming the endpoint, or null when this task cannot run yet. */
    acquire(task = {}) {
      if (inFlight() >= maxTotal) return null
      const [pick] = eligible(task).filter(free).sort(order)
      if (!pick) return null
      live.set(pick.id, load(pick) + 1)
      let released = false
      return {
        endpoint: pick,
        release() {
          if (released) return
          released = true
          live.set(pick.id, Math.max(0, (live.get(pick.id) ?? 1) - 1))
        },
      }
    },

    /** What the agent board and GET /endpoints report. */
    snapshot() {
      return endpoints.map((endpoint) => ({
        id: endpoint.id,
        label: endpoint.label,
        kind: endpoint.kind,
        model: endpoint.model,
        healthy: usable(endpoint),
        running: load(endpoint),
        concurrency: endpoint.concurrency,
        kinds: endpoint.kinds,
      }))
    },
  }
}
