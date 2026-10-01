import { hostname } from 'node:os'
import { endpointKey } from '../bridge/endpoints.mjs'
import { MODELS } from './config.mjs'

/**
 * A task that runs on another machine.
 *
 * This is the whole of the remote endpoint kind. Where the worker starts an
 * Agent SDK run here, this posts the task to another host's standalone remote runtime and
 * watches it: the same outcome shape comes back, so the scheduler cannot tell
 * the difference and nothing above it had to learn about hosts.
 *
 * What does NOT travel is decided in bridge/endpoints.mjs and agents/pool.mjs,
 * not here — by the time a task reaches this file the pool has already ruled
 * that it may go. What this file owes the user is the other half: the token is
 * only ever sent over TLS or a network TLS (the endpoint could not have been parsed otherwise), the remote task id is recorded before the first poll
 * so a restart re-attaches instead of running the work twice, and a cancel here
 * is a cancel there.
 */

const TERMINAL = ['done', 'failed', 'blocked', 'cancelled']

/** A few bad answers in a row is a host rebooting; many is a host that is gone. */
const MAX_MISSES = 5

const cancelled = { status: 'cancelled', result: null, failure: { reason: 'cancelled', detail: 'Stopped by the user.' } }

const failed = (detail) => ({ status: 'failed', result: null, failure: { reason: 'remote', detail } })

/**
 * A poll interval that ends early when the user cancels. Without this a stop
 * would sit out the rest of the interval before anything happened, and the task
 * would look ignored for as long as the poll is slow.
 */
function until(ms, signal, sleep) {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    Promise.resolve(sleep(ms)).then(done, done)
  })
}

/** This machine, as the other one will show it on its board. */
export const hostLabel = (env = process.env) => env.JARVIS_HOST_LABEL || hostname()

/**
 * The model to ask for. A size means the same thing on any host; an endpoint id
 * means nothing on another machine, and naming one there would pin the work to
 * a box that host has never heard of — so it is dropped and the remote default
 * stands.
 */
export const remoteModel = (model) => (Object.hasOwn(MODELS, model ?? '') ? model : null)

export async function runRemoteTask(task, deps) {
  const {
    store, endpoint, signal, onRemote, onLost,
    fetchFn = fetch, env = process.env, pollMs = 5000, requestMs = 15_000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps

  if (!/^https:\/\//i.test(endpoint.baseURL ?? '')) return failed(`Endpoint "${endpoint.id}" requires HTTPS.`)
  const key = endpointKey(endpoint, env)
  if (!key) {
    return failed(`Endpoint "${endpoint.id}" has no token; set ${endpoint.apiKeyEnv || 'its apiKeyEnv'} to that host's JARVIS_AGENTS_TOKEN.`)
  }

  const call = async (method, path, body) => {
    const res = await fetchFn(`${endpoint.baseURL}${path}`, {
      method,
      signal: AbortSignal.timeout(requestMs),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) throw new Error(data?.error ?? `${method} ${path} answered ${res.status}`)
    return data
  }

  const progress = (text) =>
    store.appendEvent({ type: 'task_progress', goalId: task.goalId, taskId: task.id, text })

  const goal = store.getGoal(task.goalId)

  // A task already posted before a restart is re-attached rather than sent
  // again: the other host is still working on it, and a second copy would both
  // duplicate the work and lose the first one's result.
  if (task.remote && task.remote.endpointId !== endpoint.id) {
    return failed(`Task is already delegated to ${task.remote.endpointId}; it cannot be posted to ${endpoint.id}.`)
  }
  let id = task.remote?.id ?? null
  if (!id) {
    if (signal?.aborted) return cancelled
    try {
      const created = await call('POST', '/tasks', {
        title: task.title,
        brief: task.brief,
        kind: task.kind,
        model: remoteModel(task.model),
        budget: task.budget,
        allowedSkills: task.allowedSkills ?? [],
        origin: {
          label: hostLabel(env),
          taskId: task.id,
          goalTitle: goal?.title ?? '',
          goalOutcome: goal?.outcome ?? '',
        },
      })
      id = created?.id
      if (!id) return failed(`${endpoint.label} accepted the task but named no id for it.`)
    } catch (err) {
      return failed(`${endpoint.label} refused the task: ${err.message}`)
    }
    try {
      onRemote?.({ endpointId: endpoint.id, id })
    } catch (err) {
      onLost?.(err)
      return failed(`Could not record delegation to ${endpoint.label}: ${err.message}`)
    }
    progress(`Delegated to ${endpoint.label} as ${id}.`)
  }

  const done = (outcome) => {
    onRemote?.(null)
    return outcome
  }

  const stop = async () => {
    try {
      await call('POST', `/tasks/${id}/cancel`)
      return done(cancelled)
    } catch (err) {
      // The remote run may still be active. Keep the handle for an explicit retry.
      onLost?.(err)
      return failed(`Could not confirm cancellation on ${endpoint.label}: ${err.message}`)
    }
  }

  let cursor = 0
  let misses = 0
  let sawApproval = false

  for (;;) {
    if (signal?.aborted) return stop()

    let state
    try {
      state = await call('GET', `/tasks/${id}?since=${cursor}`)
      misses = 0
    } catch (err) {
      if (++misses >= MAX_MISSES) {
        // The handle is deliberately kept: that host is probably still working
        // on this, so a retry should re-attach to the run rather than start a
        // second copy of it. The endpoint is marked unreachable so the pool
        // stops handing it work in the meantime.
        onLost?.(err)
        return failed(`Lost contact with ${endpoint.label}: ${err.message}`)
      }
      await until(pollMs, signal, sleep)
      continue
    }

    for (const ev of state.events ?? []) progress(`${endpoint.label}: ${ev.text}`)
    cursor = Number(state.eventCount) || cursor

    // A hard stop on the other machine is answered on that machine's board.
    // Said once here, so this one does not look merely slow.
    if (state.status === 'awaiting_approval' && !sawApproval) {
      sawApproval = true
      progress(`${endpoint.label} is waiting on an approval, which must be answered there.`)
    }

    if (TERMINAL.includes(state.status)) {
      return done({ status: state.status, result: state.result ?? null, failure: state.failure ?? null })
    }

    await until(pollMs, signal, sleep)
  }
}

/** The scheduler's runTask, for endpoints whose work happens elsewhere. */
export function createRemoteRunner(options = {}) {
  return (task, deps) => runRemoteTask(task, { ...options, ...deps })
}
