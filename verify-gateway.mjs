/**
 * Plan verification 4: one real task run through a gateway endpoint.
 *
 * Confirms three things the unit tests cannot: that the SDK child actually
 * talks to the gateway, that ANTHROPIC_BASE_URL reached it, and that
 * JARVIS_AGENTS_TOKEN did not.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEndpoint } from './bridge/endpoints.mjs'
import { runTask } from './agents/worker.mjs'

const cwd = mkdtempSync(join(tmpdir(), 'gw-'))
writeFileSync(join(cwd, 'NOTES.md'), 'nothing yet\n')

const events = []
const store = {
  getGoal: () => ({ id: 'g1', title: 'Verify the gateway path', brief: 'Prove a task can run on a local model.' }),
  appendEvent: (e) => { events.push(e); console.log(`[event] ${e.type}: ${e.text ?? ''}`) },
}
const approvals = { request: async () => ({ approved: false, note: 'not in this harness' }), expire: () => {} }

const task = {
  id: 't1',
  goalId: 'g1',
  kind: 'research',
  title: 'Say hello from the local model',
  brief: 'Call the report tool once with status "done" and the summary "gateway reached". Do nothing else.',
  model: process.argv[2] ?? 'llama-gw',
  budget: { maxMinutes: 20, maxTurns: 4, maxUsd: 1 },
  workspace: { path: cwd },
  allowedSkills: [],
}

const endpoint = getEndpoint(task.model)
if (!endpoint) throw new Error(`no endpoint "${task.model}" — is JARVIS_ENDPOINTS set?`)
console.log('[harness] endpoint:', endpoint.id, endpoint.kind, endpoint.baseURL, endpoint.model)

/** Read the environment of every live descendant, looking for the two names. */
const seen = { base: null, token: false, pids: 0 }
async function sniff() {
  const names = (await readdir('/proc')).filter((n) => /^\d+$/.test(n))
  for (const pid of names) {
    let env
    try {
      env = await readFile(`/proc/${pid}/environ`, 'utf8')
    } catch { continue }
    if (!env.includes('CLAUDE_CODE_ENTRYPOINT') && !env.includes('ANTHROPIC_BASE_URL')) continue
    if (Number(pid) === process.pid) continue
    const vars = Object.fromEntries(env.split('\0').filter(Boolean).map((s) => {
      const i = s.indexOf('=')
      return [s.slice(0, i), s.slice(i + 1)]
    }))
    if (!vars.ANTHROPIC_BASE_URL) continue
    seen.pids += 1
    seen.base = vars.ANTHROPIC_BASE_URL
    if (vars.JARVIS_AGENTS_TOKEN) seen.token = true
    console.log(`[sniff] pid ${pid}: ANTHROPIC_BASE_URL=${vars.ANTHROPIC_BASE_URL} ANTHROPIC_MODEL=${vars.ANTHROPIC_MODEL} JARVIS_AGENTS_TOKEN=${vars.JARVIS_AGENTS_TOKEN ? 'PRESENT' : 'absent'} keys=${Object.keys(vars).length}`)
  }
}
const sniffer = setInterval(() => { sniff().catch(() => {}) }, 400)

const started = Date.now()
let outcome
try {
  outcome = await runTask(task, {
    store, approvals, contacts: () => [], mcpServers: {}, endpoint,
    prepare: () => cwd,
  })
} catch (err) {
  outcome = { status: 'threw', failure: { reason: err.message } }
} finally {
  clearInterval(sniffer)
}

console.log('\n=== RESULT ===')
console.log('elapsed:', Math.round((Date.now() - started) / 1000), 's')
console.log('outcome:', JSON.stringify(outcome, null, 2))
console.log('events:', events.map((e) => e.type).join(', ') || '(none)')
console.log('child processes seen with ANTHROPIC_BASE_URL:', seen.pids)
console.log('ANTHROPIC_BASE_URL in child:', seen.base ?? 'NOT OBSERVED')
console.log('JARVIS_AGENTS_TOKEN in child:', seen.token ? 'LEAKED' : 'absent')
