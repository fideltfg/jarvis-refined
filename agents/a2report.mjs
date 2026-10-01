import { createHash } from 'node:crypto'
import { encode, decode, toEnglish } from '../../A2/codec.mjs'
import { BLOCKERS } from './config.mjs'

const canonical = (v) => Array.isArray(v) ? v.map(canonical)
  : (!v || typeof v !== 'object') ? v
  : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))

/**
 * The worker's report to the coordinator, as an A2 frame.
 *
 * Today a worker finishes by calling report() with a status and a few
 * sentences, and runTask flattens that into result.summary or failure.detail.
 * The coordinator then re-reads that prose to decide whether to retry, follow
 * up, escalate or complete. Everything the decision actually turns on —
 * is it blocked, on what, how sure is the agent, what does it need, is it
 * safe to retry — lives only in the sentences.
 *
 * An A2 frame carries those as fields, so the coordinator routes on structure
 * and reads prose only when it wants the detail. The summary itself stays out
 * of the frame and travels beside it in the store record: A2 has no free-text
 * slot that is not a semantic claim, and forcing prose into a step subject
 * would say the agent performed an action it did not perform.
 *
 * The frame says nothing about whether the work was done well, or at all.
 * It is the agent's claim, validated for shape. Verification stays here.
 */

/** Vocabulary for agent reports. Sent once in full, then referenced by hash. */
export const REPORT_VOCAB = {
  version: 2,
  codes: {
    i: { rs: 'report status', al: 'raise an alert', qs: 'ask a question' },
    s: { wip: 'in progress', ok: 'completed successfully', blk: 'blocked', err: 'failed' },
    ask: { ack: 'acknowledge', ans: 'answer', app: 'approve', rev: 'review' },
    risk: { na: 'not assessed', lo: 'low', me: 'medium', hi: 'high', cr: 'critical' },
    a: { inspect: 'inspect', write: 'write', edit: 'edit', test: 'test', fetch: 'fetch', deploy: 'deploy', wait: 'wait' },
    c: {
      'jg.blocked.approval': { ref: { ns: 'jarvis', id: 'blocked.approval' }, en: 'Waiting on the user to approve an action' },
      'jg.blocked.credential': { ref: { ns: 'jarvis', id: 'blocked.credential' }, en: 'A credential or access token is missing' },
      'jg.blocked.decision': { ref: { ns: 'jarvis', id: 'blocked.decision' }, en: 'A decision only the user can make' },
      'jg.blocked.dependency': { ref: { ns: 'jarvis', id: 'blocked.dependency' }, en: 'An earlier task has not produced what this one needs' },
      'jg.blocked.upstream': { ref: { ns: 'jarvis', id: 'blocked.upstream' }, en: 'An external service is unavailable or refusing' },
      'jg.blocked.unspecified': { ref: { ns: 'jarvis', id: 'blocked.unspecified' }, en: 'Blocked for a reason the agent did not name' },
      'jg.failed.budget': { ref: { ns: 'jarvis', id: 'failed.budget' }, en: 'The run exhausted its time, turn or cost budget' },
      'jg.failed.error': { ref: { ns: 'jarvis', id: 'failed.error' }, en: 'The run ended in an error' },
      'jg.done': { ref: { ns: 'jarvis', id: 'done' }, en: 'The task brief was carried out' },
      'jg.progress': { ref: { ns: 'jarvis', id: 'progress' }, en: 'A step of the task is finished' },
    },
  },
}

/** First contact carries the whole vocabulary; after that, its hash will do. */
export const VOCAB_FULL = { format: 2, mode: 'full', data: REPORT_VOCAB }
export const VOCAB_HASH = `sha256:${createHash('sha256').update(JSON.stringify(canonical(REPORT_VOCAB))).digest('hex')}`
export const VOCAB_REF = { format: 2, mode: 'reference', hash: VOCAB_HASH }
/** Pass as decode/encode options once both ends have agreed the hash. */
export const VOCAB_REGISTRY = { [VOCAB_HASH]: VOCAB_FULL }

export { BLOCKERS }

/** What a blocked agent wants back, by blocker. Nothing is inferred from prose. */
const ASK_FOR = { approval: 'app', credential: 'ans', decision: 'ans', dependency: 'rev', upstream: 'ack' }

/**
 * Build the frame. `report` is the worker's report() call, widened with the
 * fields that today have nowhere to go: blocker, need, risk, confidence.
 */
export function reportFrame(task, report, { vocab = VOCAB_FULL, vocabularies = VOCAB_REGISTRY } = {}) {
  const terminal = report.status !== 'progress'
  const blocker = report.status === 'blocked' && BLOCKERS.includes(report.blocker) ? report.blocker : null
  const concept = report.status === 'done'
    ? 'jg.done'
    : report.status === 'progress'
      ? 'jg.progress'
      : report.status === 'blocked'
        // An unnamed blocker stays blocked and unspecified. It is never
        // promoted to failed, and never guessed at from the prose.
        ? `jg.blocked.${blocker ?? 'unspecified'}`
        : `jg.failed.${report.reason === 'budget' ? 'budget' : 'error'}`

  const message = {
    v: 2,
    id: `${task.id}.${report.seq ?? 1}`,
    from: task.id,
    to: ['coordinator'],
    i: report.status === 'failed' ? 'al' : 'rs',
    // The agent's own confidence in its report, not the odds it is right.
    c: typeof report.confidence === 'number' ? report.confidence : 1,
    s: { progress: 'wip', done: 'ok', blocked: 'blk', failed: 'err' }[report.status] ?? 'err',
    g: `~${concept}`,
    vocab,
  }

  // Artifacts are genuine actions on genuine subjects, so they belong in steps.
  const artifacts = (report.artifacts ?? []).map((a, n) => ({ id: `art${n + 1}`, a: 'write', x: String(a), ag: task.id }))
  if (artifacts.length) message.st = artifacts

  if (blocker) message.ask = ASK_FOR[blocker]
  // What is missing. This is the field the current shape has no room for.
  if (report.need?.length) message.need = report.need.map(String)
  if (report.risk) message.risk = report.risk
  if (task.dependsOn?.length) message.dep = [...task.dependsOn]
  if (terminal && report.deadline) message.by = report.deadline

  return encode(message, { vocabularies })
}

/**
 * Read a frame back into the shape runTask already returns, plus the fields
 * the coordinator can now route on. Invalid frames throw; the caller treats
 * that as a failed report rather than guessing at the prose.
 */
export function readReport(wire, options = {}) {
  const m = decode(wire, options)
  const concept = m.g.startsWith('~') ? m.g.slice(1) : null
  const [, kind, detail] = (concept ?? '').split('.')
  return {
    taskId: m.from,
    status: { wip: 'progress', ok: 'done', blk: 'blocked', err: 'failed' }[m.s],
    reason: kind === 'blocked' || kind === 'failed' ? detail : null,
    artifacts: (m.st ?? []).map((s) => s.x),
    needs: m.need ?? [],
    ask: m.ask ?? null,
    risk: m.risk ?? 'na',
    confidence: m.c,
    english: toEnglish(m),
  }
}
