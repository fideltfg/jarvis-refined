import http from 'node:http'
import https from 'node:https'
import { isLoopback, TRAVELLING_KINDS } from '../bridge/endpoints.mjs'
import { BUDGETS } from '../agents/config.mjs'

const MAX_BODY = 64 * 1024
const MAX_TEXT = 16_000
const MAX_SKILLS = 16
const idPattern = /^t_[a-z0-9]+$/
const exact = (value, limit = MAX_TEXT) => typeof value === 'string' && value.length > 0 && value.length <= limit
const budgetFor = (kind, requested) => {
  const caps = BUDGETS[kind]
  const out = {}
  for (const key of ['maxTurns', 'maxMinutes', 'maxUsd']) {
    const n = Number(requested?.[key])
    out[key] = Math.min(Number.isFinite(n) && n > 0 ? n : caps[key], caps[key])
  }
  return out
}

export function createRemoteApi({ store, scheduler, approvals, token, host = '127.0.0.1', port = 0, tls = null }) {
  if (!token) throw new Error('JARVIS_AGENTS_TOKEN is required.')
  if (!isLoopback(host) && !tls) throw new Error('A network-facing remote runtime requires TLS.')
  const handler = async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorised' })
    const url = new URL(req.url, 'http://localhost')
    const match = /^\/tasks\/(t_[a-z0-9]+)(?:\/(cancel))?$/.exec(url.pathname)
    if (req.method === 'GET' && url.pathname === '/approvals') {
      return send(200, store.listApprovals('pending').filter((a) => store.getTask(a.taskId)?.delegated))
    }
    const approval = /^\/approvals\/(a_[a-z0-9]+)$/.exec(url.pathname)
    if (req.method === 'POST' && approval) {
      let raw = ''
      try {
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > MAX_BODY) throw new Error('Request too large.')
        }
        const body = JSON.parse(raw)
        const record = store.getApproval(approval[1])
        if (!record || !store.getTask(record.taskId)?.delegated) return send(404, { error: 'not found' })
        if (!['approve', 'deny'].includes(body.decision)) throw new Error('Expected approve or deny.')
        return send(200, approvals.decide(approval[1], body.decision, body.note ?? null))
      } catch (err) {
        return send(400, { error: err.message })
      }
    }
    if (req.method === 'GET' && url.pathname === '/endpoints') {
      return send(200, { capacity: 1, running: scheduler.running().size, endpoints: [] })
    }
    if (req.method === 'POST' && url.pathname === '/tasks') {
      let raw = ''
      try {
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > MAX_BODY) throw new Error('Request too large.')
        }
        const body = JSON.parse(raw)
        if (!body || !TRAVELLING_KINDS.includes(body.kind) || !exact(body.title, 300) || !exact(body.brief)) {
          throw new Error('A research or ops task needs a title and brief.')
        }
        if (!exact(body.origin?.label, 60) || !exact(body.origin?.taskId, 128)) throw new Error('Origin label and task id are required.')
        if (body.model != null && !['sonnet', 'opus'].includes(body.model)) throw new Error('Unsupported model.')
        if (body.allowedSkills != null && (!Array.isArray(body.allowedSkills) || body.allowedSkills.length > MAX_SKILLS ||
          body.allowedSkills.some((skill) => !exact(skill, 100)))) throw new Error('Invalid skills.')
        const key = `${body.origin.label}:${body.origin.taskId}`
        const previous = store.listTasks().find((task) => task.origin?.key === key)
        if (previous) return send(201, { id: previous.id, goalId: previous.goalId })
        let goal = store.listGoals().find((g) => g.delegated && g.title === `Delegated work from ${body.origin.label}`)
        if (!goal) {
          goal = store.newGoal({ title: `Delegated work from ${body.origin.label}`, outcome: 'Return the result to the originating host.' })
          store.saveGoal({ ...goal, delegated: true })
        }
        const context = exact(body.origin.goalTitle, 300)
          ? `\n\nOrigin goal: ${body.origin.goalTitle.slice(0, 300)}. ${String(body.origin.goalOutcome ?? '').slice(0, 500)}` : ''
        const task = store.newTask({ goalId: goal.id, title: body.title, brief: body.brief + context,
          kind: body.kind, model: body.model ?? 'sonnet', allowedSkills: body.allowedSkills ?? [] })
        store.saveTask({ ...task, budget: budgetFor(body.kind, body.budget), delegated: true,
          origin: { label: body.origin.label, taskId: body.origin.taskId, key } })
        store.appendEvent({ type: 'task_queued', goalId: goal.id, taskId: task.id, text: 'Delegated task accepted.' })
        return send(201, { id: task.id, goalId: goal.id })
      } catch (err) {
        return send(400, { error: err.message })
      }
    }
    if (match && idPattern.test(match[1])) {
      const task = store.getTask(match[1])
      if (!task?.delegated) return send(404, { error: 'not found' })
      if (req.method === 'GET' && !match[2]) {
        const since = Math.max(0, Math.floor(Number(url.searchParams.get('since')) || 0))
        const events = store.readEvents({ limit: 5000 }).filter((e) => e.taskId === task.id && e.type === 'task_progress')
        return send(200, { id: task.id, status: task.status, result: task.result ?? null,
          failure: task.failure ?? null, events: events.slice(since).map((e) => ({ at: e.at, text: e.text })), eventCount: events.length })
      }
      if (req.method === 'POST' && match[2] === 'cancel') {
        if (!scheduler.cancel(task.id)) return send(409, { error: 'Task cannot be cancelled.' })
        return send(200, { ok: true })
      }
    }
    return send(404, { error: 'not found' })
  }
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler)
  return {
    tls: Boolean(tls),
    listen: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}
