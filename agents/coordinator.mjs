import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { KINDS, MAX_ATTEMPTS, MODELS } from './config.mjs'
import { taskModels } from './pool.mjs'
import { agentEnv, usageData } from './worker.mjs'
import { scheduleModels, textQuery } from './text-query.mjs'

/**
 * The coordinator is how a goal gets thought about: a short Opus pass that
 * runs on goal creation, whenever a task ends, and when the user changes the
 * goal. It never does the work — it only acts through the tools below, and it
 * reads a compact snapshot rather than worker transcripts, so it stays cheap.
 */

export const COORDINATOR_PROMPT = `You coordinate background agents for JARVIS, the user's assistant, toward one goal.
You never do the work yourself; you decide what work happens next, using only your tools.

Planning a new goal: create 2 to 6 tasks with plan_tasks. Each brief must stand alone — the agent sees only its brief and the goal. Use dependsOn when a task needs another's result, and say in the later brief where to find it. Choose kind carefully:
- code: changes in a git repository. Set repo to its absolute path.
- research: web research and written reports.
- marketing: software positioning, market research, launch plans and marketing copy. Keep claims evidence-based; workers draft but never publish or contact prospects.
- ops: operating services through the user's connected tools.
- admin: email, calendar and browser tasks on the user's behalf.
Use model "opus" only for tasks that need deep reasoning; the default is "sonnet". The model may also be one of the other endpoint ids the tool schema lists: those are the user's own machines, cheap to run and suited to routine research and summarising, but slower and weaker at code — pin a task to one only when the work is simple and the queue is busy.

Reviewing: read the trigger and the task results, then do one of:
- add follow-up tasks with plan_tasks,
- retry a failed or blocked task with update_task (status "queued"), usually with a revised brief,
- complete_goal when the outcome is met, with a two-sentence summary,
- escalate when you need the user: missing information, repeated failure, or a decision only they can make.
Always keep note current: a short running summary of where the goal stands.
Never create tasks that repeat work already done. If tasks are still running and nothing else is needed, just update the note.`

const OPEN = ['queued', 'running', 'awaiting_approval']

const describe = (trigger) =>
  trigger.type === 'goal_created'
    ? 'This goal was just created. Plan it.'
    : trigger.type === 'user_update'
      ? `The user says: ${trigger.text}`
      : String(trigger.text ?? trigger.type)

export function snapshot(store, goalId, trigger) {
  const goal = store.getGoal(goalId)
  const tasks = store.listTasks({ goalId }).filter((t) => !t.archived).sort((a, b) => a.created.localeCompare(b.created))
  const line = (t) => {
    const state = t.status === 'failed'
      ? `failed: ${t.failure?.reason ?? 'error'}, attempts ${t.attempts}/${MAX_ATTEMPTS}`
      : t.status === 'blocked'
        ? `blocked: ${t.failure?.blocker ?? 'unspecified'}${t.failure?.risk && t.failure.risk !== 'na' ? `, risk ${t.failure.risk}` : ''}`
        : t.status
    const after = t.dependsOn.length ? ` — after ${t.dependsOn.join(', ')}` : ''
    const tail = t.result?.summary ?? t.failure?.detail ?? ''
    // What a blocked agent said it needs, stated as its own line so it is not
    // buried in prose. An empty list means it named nothing, not that it needs
    // nothing.
    const needs = t.failure?.need?.length ? `\n    Needs: ${t.failure.need.join('; ')}` : ''
    return `- ${t.id} [${state}] (${t.kind}) ${t.title}${after}${tail ? `\n    ${tail.slice(0, 400)}` : ''}${needs}`
  }
  return [
    `GOAL ${goal.id}: ${goal.title}`,
    `Done means: ${goal.outcome}`,
    `Status: ${goal.status} · priority ${goal.priority} · ${tasks.length}/${goal.taskCap} tasks used${goal.recurring ? ` · recurring every ${goal.recurring.every}` : ''}`,
    `Note: ${goal.notes || '(none yet)'}`,
    '',
    'TASKS:',
    tasks.length ? tasks.map(line).join('\n') : '(none yet)',
    '',
    `TRIGGER: ${describe(trigger)}`,
  ].join('\n')
}

export function createActions(store, goalId, { mirror = {}, created = [] } = {}) {
  const goal = () => store.getGoal(goalId)

  return {
    plan_tasks({ tasks }) {
      const g = goal()
      if (!Array.isArray(tasks) || !tasks.length) return 'No tasks given.'
      const existing = store.listTasks({ goalId }).filter((t) => !t.archived)
      if (existing.length + tasks.length > g.taskCap) {
        return `Refused: this goal may have at most ${g.taskCap} tasks and already has ${existing.length}. Use escalate to ask the user how to proceed.`
      }
      const keys = new Set()
      const ids = new Set(existing.map((t) => t.id))
      for (const t of tasks) {
        if (!KINDS.includes(t.kind)) return `Refused: unknown kind "${t.kind}". Use one of ${KINDS.join(', ')}.`
        if (t.repo && (!isAbsolute(t.repo) || !existsSync(t.repo))) {
          return `Refused: repo must be the absolute path of an existing repository; got "${t.repo}".`
        }
        const bad = (t.dependsOn ?? []).filter((d) => !keys.has(d) && !ids.has(d))
        if (bad.length) {
          return `Refused: unknown dependency ${bad.join(', ')}. Name an earlier task in this call by key, or an existing task id.`
        }
        keys.add(t.key ?? t.title)
      }
      const byKey = new Map()
      const made = []
      for (const t of tasks) {
        const task = store.newTask({
          goalId,
          title: t.title,
          brief: t.brief,
          kind: t.kind,
          dependsOn: (t.dependsOn ?? []).map((d) => byKey.get(d) ?? d),
          model: t.model,
          repo: t.repo ?? null,
        })
        byKey.set(t.key ?? t.title, task.id)
        made.push(task)
        created.push(task)
        store.appendEvent({ type: 'task_queued', goalId, taskId: task.id, text: `Queued: ${task.title}`, data: { title: task.title } })
      }
      return `Created ${made.map((m) => `${m.id} "${m.title}"`).join(', ')}.`
    },

    update_task({ taskId, brief, status, model }) {
      const t = store.getTask(taskId)
      if (!t || t.goalId !== goalId) return `No task ${taskId} in this goal.`
      const next = { ...t }
      if (brief) next.brief = String(brief)
      if (!t.execution && (model === 'opus' || model === 'sonnet')) next.model = model
      if (status === 'queued') {
        if (!['failed', 'blocked'].includes(t.status)) {
          return `Refused: only a failed or blocked task can be retried; ${taskId} is ${t.status}.`
        }
        if (t.attempts >= MAX_ATTEMPTS) {
          return `Refused: ${taskId} has used all ${MAX_ATTEMPTS} attempts. Plan a different approach or escalate.`
        }
        next.status = 'queued'
        next.resume = false
      } else if (status === 'cancelled') {
        if (['running', 'awaiting_approval'].includes(t.status)) return `Refused: ${taskId} is running and cannot be cancelled from here.`
        next.status = 'cancelled'
      } else if (status) {
        return 'Refused: status may only be set to queued or cancelled.'
      }
      store.saveTask(next)
      return `Updated ${taskId}.`
    },

    complete_goal({ summary }) {
      const g = goal()
      if (g.recurring) return 'Refused: a recurring goal never completes. Update the note instead.'
      const open = store.listTasks({ goalId }).filter((t) => OPEN.includes(t.status))
      if (open.length) {
        return `Refused: ${open.length} task(s) are still open. Cancel them with update_task if they are no longer needed.`
      }
      const text = String(summary ?? '')
      const saved = store.saveGoal({ ...g, status: 'done', notes: text || g.notes })
      store.appendEvent({ type: 'goal_done', goalId, text: `Goal complete: ${g.title}`, data: { title: g.title, summary: text } })
      mirror.goalDone?.(saved, text)
      return 'Goal marked done.'
    },

    note({ text }) {
      store.saveGoal({ ...goal(), notes: String(text ?? '') })
      return 'Noted.'
    },

    escalate({ reason }) {
      const g = goal()
      store.saveGoal({ ...g, status: 'paused' })
      store.appendEvent({ type: 'goal_paused', goalId, text: `${g.title} needs you: ${reason}`, data: { title: g.title, reason, awaitingResponse: true } })
      return 'Escalated; the goal is paused until the user responds.'
    },
  }
}

/**
 * Two passes in a row that plan the same work with nothing finishing in
 * between is a loop, not progress. Pause and tell the user.
 */
function checkRunaway(store, goalId, created) {
  if (!created.length) return
  const goal = store.getGoal(goalId)
  const sig = created.map((t) => t.title.trim().toLowerCase()).sort().join('|')
  const done = store.listTasks({ goalId, status: 'done' }).length
  if (goal.lastPlan && goal.lastPlan.sig === sig && goal.lastPlan.done === done) {
    for (const t of created) store.saveTask({ ...store.getTask(t.id), status: 'cancelled' })
    store.saveGoal({ ...goal, status: 'paused' })
    store.appendEvent({
      type: 'goal_paused',
      goalId,
      text: `${goal.title} is going in circles: the same work was planned twice with no progress.`,
      data: { title: goal.title, reason: 'repeated plan' },
    })
    return
  }
  store.saveGoal({ ...goal, lastPlan: { sig, done } })
}

export function sdkModel({ queryFn = query, model = MODELS.opus, maxBudgetUsd = 1, makeTextQuery = textQuery, env = process.env } = {}) {
  return async ({ prompt, actions, execution }) => {
    if (execution && !scheduleModels(env)[execution.provider]?.includes(execution.model)) {
      throw new Error(`Scheduled provider/model is unavailable: ${execution.provider}/${execution.model}. Configure it or edit the schedule.`)
    }
    const text = (s) => ({ content: [{ type: 'text', text: s }] })
    const server = createSdkMcpServer({
      name: 'coord',
      version: '1.0.0',
      tools: [
        tool('plan_tasks', 'Create tasks for this goal.', {
          tasks: z.array(z.object({
            key: z.string().describe('A short label other tasks in this call can name in dependsOn.'),
            title: z.string(),
            brief: z.string().describe('Complete, standalone instructions for the agent.'),
            kind: z.enum(KINDS),
            dependsOn: z.array(z.string()).optional(),
            model: z.string().optional().describe(`One of: ${taskModels().join(', ')}.`),
            repo: z.string().optional().describe('Absolute path of the git repository, for code tasks.'),
          })),
        }, async (a) => text(actions.plan_tasks(a))),
        tool('update_task', 'Revise a task, retry it (status "queued") or cancel it (status "cancelled").', {
          taskId: z.string(),
          brief: z.string().optional(),
          status: z.enum(['queued', 'cancelled']).optional(),
          model: z.string().optional().describe(`One of: ${taskModels().join(', ')}.`),
        }, async (a) => text(actions.update_task(a))),
        tool('complete_goal', 'Mark the goal done once its outcome is met.', { summary: z.string() }, async (a) => text(actions.complete_goal(a))),
        tool('note', 'Replace the running summary of where the goal stands.', { text: z.string() }, async (a) => text(actions.note(a))),
        tool('escalate', 'Pause the goal and ask the user for help.', { reason: z.string() }, async (a) => text(actions.escalate(a))),
      ],
    })
    const onlyCoord = async (input) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: String(input.tool_name).startsWith('mcp__coord__') ? 'allow' : 'deny',
        permissionDecisionReason: 'The coordinator acts only through its own tools.',
      },
    })
    const runQuery = execution && execution.provider !== 'claude' ? makeTextQuery(execution, { env }) : queryFn
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120000)
    let usage = null
    try {
      const stream = runQuery({
      prompt,
      options: {
        model: execution?.model ?? model,
        maxTurns: 8,
        maxBudgetUsd,
        systemPrompt: COORDINATOR_PROMPT,
        settingSources: [],
        permissionMode: 'default',
        mcpServers: { coord: server },
        hooks: { PreToolUse: [{ hooks: [onlyCoord] }] },
        canUseTool: async () => ({ behavior: 'allow' }),
        env: agentEnv(env),
        abortController: controller,
      },
      })
      for await (const msg of stream) {
        if (msg.type === 'result') {
          usage = usageData(msg)
          if (msg.subtype !== 'success' && msg.subtype !== 'error_max_turns') {
            const error = new Error(`the coordinator run ended with ${msg.subtype}`)
            error.usage = usage
            throw error
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }
    return usage
  }
}

export function createCoordinator({ store, runModel = sdkModel(), mirror = {} }) {
  const queues = new Map()
  const serial = (goalId, fn) => {
    const next = (queues.get(goalId) ?? Promise.resolve()).then(fn, fn)
    queues.set(goalId, next.catch(() => {}))
    return next
  }

  async function pass(goalId, trigger) {
    const goal = store.getGoal(goalId)
    if (!goal || goal.status !== 'active') return
    const created = []
    const actions = createActions(store, goalId, { mirror, created })
    try {
      const usage = await runModel({ prompt: snapshot(store, goalId, trigger), actions, execution: goal.execution })
      if (usage) store.appendEvent({ type: 'coordinator_usage', goalId, text: 'Coordinator usage', data: usage })
    } catch (err) {
      if (err.usage) store.appendEvent({ type: 'coordinator_usage', goalId, text: 'Coordinator usage', data: err.usage })
      store.appendEvent({ type: 'coordinator_error', goalId, text: `The coordinator failed on ${goal.title}: ${err.message}` })
      throw err
    }
    checkRunaway(store, goalId, created)
  }

  return {
    plan: (goalId) => serial(goalId, () => pass(goalId, { type: 'goal_created' })),
    review: (goalId, event) => serial(goalId, () => pass(goalId, event)),
    redirect: (goalId, text) => serial(goalId, () => pass(goalId, { type: 'user_update', text })),
  }
}
