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
 * only ever sent over TLS (the endpoint could not have been parsed otherwise), the remote task id is recorded before the first poll
 * so a restart re-attaches instead of running the work twice, and a cancel here
 * is a cancel there.
 */

const TERMINAL = ['done', 'failed', 'blocked', 'cancelled']

/** A few bad answers in a row is a host rebooting; many is a host that is gone. */
const MAX_MISSES = 5

const cancelled = { status: 'cancelled', result: null, failure: { reason: 'cancelled', detail: 'Stopped by the user.' } }

/** Build the scheduler's standard failure shape for a remote-host problem. */
const failed = (detail) => ({ status: 'failed', result: null, failure: { reason: 'remote', detail } })

/**
 * A poll interval that ends early when the user cancels. Without this a stop
 * would sit out the rest of the interval before anything happened, and the task
 * would look ignored for as long as the poll is slow.
 */
/** Wait for a poll interval, but return immediately when cancellation arrives. */
function until(ms, signal, sleep) {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    /** Remove the abort listener and settle the wait exactly once. */
    const done = () => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    // Treat timer completion and injected-sleep failure as the same wake-up.
    Promise.resolve(sleep(ms)).then(done, done)
  })
}

/** This machine, as the other one will show it on its board. */
/** Return the configured origin label or this machine's hostname. */
export const hostLabel = (env = process.env) => env.JARVIS_HOST_LABEL || hostname()

/**
 * The model to ask for. A size means the same thing on any host; an endpoint id
 * means nothing on another machine, and naming one there would pin the work to
 * a box that host has never heard of — so it is dropped and the remote default
 * stands.
 */
export const remoteModel = (model) => (Object.hasOwn(MODELS, model ?? '') ? model : null)

/** Delegate one task over HTTPS, persist its remote handle, and mirror progress. */
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

  /** Make one authenticated JSON request and attach HTTP status to failures. */
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
    if (!res.ok) {
      const err = new Error(data?.error ?? `${method} ${path} answered ${res.status}`)
      err.status = res.status
      throw err
    }
    return data
  }

  /** Append remote progress to the originating host's task event stream. */
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
      if (!id) {
        onLost?.(new Error('Remote host returned no task id.'))
        return failed(`${endpoint.label} accepted the task but named no id for it.`)
      }
    } catch (err) {
      // A timed-out POST may still have reached the host. Its origin key is
      // idempotent there; leave this task queued for an explicit retry.
      if (err.status) return failed(`${endpoint.label} refused the task: ${err.message}`)
      onLost?.(err)
      return failed(`${endpoint.label} could not confirm the task: ${err.message}`)
    }
    try {
      onRemote?.({ endpointId: endpoint.id, id })
    } catch (err) {
      onLost?.(err)
      return failed(`Could not record delegation to ${endpoint.label}: ${err.message}`)
    }
    progress(`Delegated to ${endpoint.label} as ${id}.`)
  }

  /** Clear the persisted remote handle after a confirmed terminal outcome. */
  const done = (outcome) => {
    onRemote?.(null)
    return outcome
  }

  /** Forward cancellation to the remote host and retain the handle on failure. */
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

  // Poll until the remote task is terminal or repeated failures prove it lost.
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

    // Mirror only newly reported progress events from the remote cursor.
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
/** Bind remote endpoint options to the scheduler's runTask function shape. */
export function createRemoteRunner(options = {}) {
  return (task, deps) => runRemoteTask(task, { ...options, ...deps })
}
