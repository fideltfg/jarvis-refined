import http from 'node:http'
import { boardOf, briefing } from './briefing.mjs'

/**
 * The agent service's only door: loopback HTTP with a bearer token, plus an
 * SSE stream of events for the bridge. Nothing here is reachable from the LAN.
 */

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) {
        reject(new Error('Body too large.'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

class NotFound extends Error {}

export function createApi({ store, scheduler, coordinator, approvals, cleanup, mirror = {}, pool = null, token, host = '127.0.0.1', port = 0 }) {
  if (!token) throw new Error('JARVIS_AGENTS_TOKEN is not set; refusing to start an unauthenticated API.')

  const clients = new Set()
  const off = store.onEvent((ev) => {
    for (const res of clients) res.write(`data: ${JSON.stringify(ev)}\n\n`)
  })
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n')
  }, 25_000)
  const warn = (err) => console.warn('[agents]', err.message)

  function changeGoal(goal, body) {
    const event = (action) =>
      store.appendEvent({ type: 'goal_changed', goalId: goal.id, text: `${goal.title}: ${action}`, data: { title: goal.title, action } })
    if (typeof body.info === 'string') {
      event('updated')
      coordinator.redirect(goal.id, body.info).catch(warn)
      return goal
    }
    if (body.action === 'pause') {
      const g = store.saveGoal({ ...goal, status: 'paused' })
      event('paused')
      return g
    }
    if (body.action === 'resume') {
      const g = store.saveGoal({ ...goal, status: 'active' })
      event('resumed')
      coordinator.redirect(g.id, 'The user resumed this goal. Continue.').catch(warn)
      return g
    }
    if (body.action === 'abandon') {
      for (const t of store.listTasks({ goalId: goal.id })) {
        if (['queued', 'running', 'awaiting_approval', 'blocked'].includes(t.status)) scheduler.cancel(t.id)
      }
      const g = store.saveGoal({ ...goal, status: 'abandoned' })
      event('abandoned')
      return g
    }
    throw new Error('A change must be pause, resume, abandon, or info.')
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorised' })

    const url = new URL(req.url, 'http://x')
    const [head, id, tail] = url.pathname.split('/').filter(Boolean)
    const route = `${req.method} /${[head, id && ':id', tail].filter(Boolean).join('/')}`

    if (route === 'GET /events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    let body = {}
    if (req.method === 'POST') {
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return send(400, { error: 'The body must be JSON.' })
      }
    }

    try {
      switch (route) {
        case 'GET /board':
          return send(200, boardOf(store, scheduler.running()))
        // Where the capacity is, and how much of it is busy. Endpoint ids and
        // labels only: no base URLs and no keys leave the process.
        case 'GET /endpoints':
          return send(200, pool
            ? { capacity: pool.capacity(), running: pool.inFlight(), endpoints: pool.snapshot() }
            : { capacity: null, running: scheduler.running().size, endpoints: [] })
        case 'GET /status':
          return send(200, { text: briefing(store, url.searchParams.get('goal') || undefined) })
        case 'POST /goals': {
          const goal = store.newGoal(body)
          store.appendEvent({ type: 'goal_created', goalId: goal.id, text: `New goal: ${goal.title}`, data: { title: goal.title } })
          mirror.goalCreated?.(goal)
          coordinator.plan(goal.id).catch(warn)
          return send(201, goal)
        }
        case 'POST /goals/:id': {
          const goal = store.getGoal(id)
          if (!goal) throw new NotFound(`No goal ${id}.`)
          return send(200, changeGoal(goal, body))
        }
        case 'POST /tasks/:id/cancel':
          if (!scheduler.cancel(id)) throw new NotFound(`No cancellable task ${id}.`)
          return send(200, { ok: true })
        case 'GET /approvals':
          return send(200, store.listApprovals('pending'))
        case 'POST /approvals/:id':
          return send(200, approvals.decide(id, body.decision, body.note ?? null))
        case 'POST /cleanup':
          return send(200, { removed: cleanup() })
        default:
          return send(404, { error: 'not found' })
      }
    } catch (err) {
      return send(err instanceof NotFound ? 404 : 400, { error: err.message })
    }
  })

  return {
    listen: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close() {
      off()
      clearInterval(heartbeat)
      for (const res of clients) res.end()
      clients.clear()
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
