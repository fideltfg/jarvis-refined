import { readFileSync } from 'node:fs'

/**
 * Where the models actually live.
 *
 * One list, declared once, so nothing else has to know whether a model runs on
 * this machine, on another box on the network, or behind someone else's API.
 * Set JARVIS_ENDPOINTS to a JSON array (inline, or a path to a file holding
 * one); each entry is:
 *
 *   { "id": "rigel", "kind": "openai", "baseURL": "http://11.0.0.9:11434/v1",
 *     "model": "llama3.1:8b", "concurrency": 2, "kinds": ["research"],
 *     "apiKeyEnv": "RIGEL_KEY", "weight": 1, "label": "the big box" }
 *
 * kind is how the endpoint is spoken to, not what it runs:
 *   anthropic — the Anthropic API (or a login, as the bridge uses today).
 *   openai    — anything OpenAI-compatible: Ollama, vLLM, LM Studio, OpenAI.
 *   gateway   — an Anthropic-compatible proxy, which is the only way the agent
 *               SDK can be pointed at a model that is not Claude.
 *
 * The old single-endpoint variables still work: with JARVIS_ENDPOINTS unset,
 * JARVIS_LOCAL_URL and JARVIS_LOCAL_MODEL synthesise one endpoint called
 * "local", which is exactly what they meant before.
 */

export const ENDPOINT_KINDS = ['anthropic', 'openai', 'gateway']
export const DEFAULT_CONCURRENCY = 1

const trimSlashes = (url) => String(url).replace(/\/+$/, '')

function readSource(raw) {
  const text = String(raw).trim()
  if (!text) return null
  if (text.startsWith('[') || text.startsWith('{')) return text
  try {
    return readFileSync(text, 'utf8')
  } catch (err) {
    throw new Error(`JARVIS_ENDPOINTS points at ${text}, which could not be read: ${err.message}`)
  }
}

/**
 * A bad entry is dropped with a warning rather than taking the process down:
 * one mistyped endpoint must not cost the user every other one.
 */
function coerce(entry, index) {
  if (!entry || typeof entry !== 'object') throw new Error(`entry ${index} is not an object`)
  const id = String(entry.id ?? '').trim()
  if (!id) throw new Error(`entry ${index} has no id`)
  const kind = String(entry.kind ?? 'openai')
  if (!ENDPOINT_KINDS.includes(kind)) {
    throw new Error(`endpoint "${id}" has kind "${kind}"; use one of ${ENDPOINT_KINDS.join(', ')}`)
  }
  const baseURL = entry.baseURL ? trimSlashes(entry.baseURL) : null
  if (kind !== 'anthropic' && !baseURL) throw new Error(`endpoint "${id}" needs a baseURL`)
  if (kind === 'openai' && !entry.model) throw new Error(`endpoint "${id}" needs a model`)
  const concurrency = Math.max(1, Math.trunc(Number(entry.concurrency ?? DEFAULT_CONCURRENCY)) || DEFAULT_CONCURRENCY)
  return {
    id,
    kind,
    baseURL,
    model: entry.model ? String(entry.model) : null,
    apiKeyEnv: entry.apiKeyEnv ? String(entry.apiKeyEnv) : null,
    concurrency,
    kinds: Array.isArray(entry.kinds) ? entry.kinds.map(String) : [],
    weight: Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 1,
    label: entry.label ? String(entry.label) : id,
  }
}

export function parseEndpoints(raw, { warn = console.warn } = {}) {
  const text = typeof raw === 'string' ? readSource(raw) : null
  const list = Array.isArray(raw) ? raw : text ? JSON.parse(text) : []
  if (!Array.isArray(list)) throw new Error('JARVIS_ENDPOINTS must be a JSON array of endpoints.')
  const out = []
  const seen = new Set()
  for (const [index, entry] of list.entries()) {
    try {
      const endpoint = coerce(entry, index)
      if (seen.has(endpoint.id)) throw new Error(`endpoint "${endpoint.id}" is declared twice`)
      seen.add(endpoint.id)
      out.push(endpoint)
    } catch (err) {
      warn(`[jarvis] ignoring an endpoint: ${err.message}`)
    }
  }
  return out
}

/** The single local endpoint the old variables described. */
function legacyLocal(env) {
  if (!env.JARVIS_LOCAL_URL || !env.JARVIS_LOCAL_MODEL) return []
  return [coerce({
    id: 'local',
    kind: 'openai',
    baseURL: env.JARVIS_LOCAL_URL,
    model: env.JARVIS_LOCAL_MODEL,
    apiKeyEnv: env.JARVIS_LOCAL_API_KEY ? 'JARVIS_LOCAL_API_KEY' : null,
  }, 0)]
}

export function listEndpoints(env = process.env, options = {}) {
  const declared = env.JARVIS_ENDPOINTS ? parseEndpoints(env.JARVIS_ENDPOINTS, options) : []
  return declared.length ? declared : legacyLocal(env)
}

export function getEndpoint(id, env = process.env) {
  return listEndpoints(env).find((endpoint) => endpoint.id === id) ?? null
}

/** Endpoints eligible for a piece of work, before any health or load check. */
export function endpointsFor({ kind = null, taskKind = null } = {}, env = process.env) {
  return listEndpoints(env).filter((endpoint) =>
    (!kind || endpoint.kind === kind) &&
    (!taskKind || !endpoint.kinds.length || endpoint.kinds.includes(taskKind)))
}

/** The key for an endpoint, named by variable so no secret sits in the list. */
export function endpointKey(endpoint, env = process.env) {
  if (!endpoint) return null
  if (endpoint.apiKeyEnv && env[endpoint.apiKeyEnv]) return env[endpoint.apiKeyEnv]
  if (endpoint.kind === 'anthropic') return env.ANTHROPIC_API_KEY ?? null
  if (endpoint.id === 'local' && env.JARVIS_LOCAL_API_KEY) return env.JARVIS_LOCAL_API_KEY
  return null
}

/**
 * An openai baseURL already ends in the version segment, by that API's own
 * convention. A gateway's does not: it is handed to the agent SDK as
 * ANTHROPIC_BASE_URL, which appends /v1/messages itself. So the probe has to
 * put the version back, or every correctly configured gateway reads as dead.
 */
const probePath = (endpoint) => (endpoint.kind === 'gateway' ? '/v1/models' : '/models')

/**
 * Reachable, not correct: a 401 means the box answered and the key is wrong,
 * which is a configuration fault to report rather than a dead host to skip.
 */
export async function probeEndpoint(endpoint, { fetchFn = fetch, timeoutMs = 2500, env = process.env } = {}) {
  if (!endpoint.baseURL) return true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const key = endpointKey(endpoint, env)
    const res = await fetchFn(`${endpoint.baseURL}${probePath(endpoint)}`, {
      method: 'GET',
      signal: controller.signal,
      headers: key ? { authorization: `Bearer ${key}` } : {},
    })
    return res.ok || res.status === 401 || res.status === 403
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Health with a memory. An endpoint is assumed good until a probe says
 * otherwise, and a verdict is cached, so nothing waits on a dead host twice in
 * the same minute.
 */
export function createHealth({ ttlMs = 60_000, now = Date.now, probe = probeEndpoint, env = process.env } = {}) {
  const state = new Map()
  return {
    healthy(id) {
      return state.get(id)?.ok ?? true
    },
    mark(id, ok) {
      state.set(id, { ok, at: now() })
    },
    async check(endpoint, { force = false } = {}) {
      const last = state.get(endpoint.id)
      if (!force && last && now() - last.at < ttlMs) return last.ok
      const ok = await probe(endpoint, { env })
      state.set(endpoint.id, { ok, at: now() })
      return ok
    },
    async checkAll(endpoints, options) {
      await Promise.all(endpoints.map((endpoint) => this.check(endpoint, options)))
      return endpoints.filter((endpoint) => this.healthy(endpoint.id))
    },
    snapshot() {
      return [...state.entries()].map(([id, { ok, at }]) => ({ id, healthy: ok, checked: at }))
    },
  }
}
