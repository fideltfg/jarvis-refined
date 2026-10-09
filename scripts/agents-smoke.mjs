/**
 * End-to-end check against the running agent service: create a small, safe
 * research goal and wait for it to finish. Costs a few model calls.
 *
 *   node --env-file=$HOME/.config/jarvis/secrets.env scripts/agents-smoke.mjs
 */
const base = `http://127.0.0.1:${Number(process.env.JARVIS_AGENTS_PORT) || 8788}`
const token = process.env.JARVIS_AGENTS_TOKEN
if (!token) {
  console.error('JARVIS_AGENTS_TOKEN is not set.')
  process.exit(2)
}
/** Send one authenticated agent-service request and surface API errors. */
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? res.status)
  return data
}

const goal = await call('POST', '/goals', {
  title: 'Smoke test: Agent SDK summary',
  outcome: 'A Markdown file of at most 200 words summarising what the Claude Agent SDK is, saved in the task folder.',
  priority: 5,
})
console.log(`created ${goal.id}; waiting up to 20 minutes`)
const deadline = Date.now() + 20 * 60_000
while (Date.now() < deadline) {
  // Poll at a human-scale interval without keeping the service busy.
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  const g = (await call('GET', '/board')).goals.find((candidate) => {
    // Select the goal created by this smoke run from the current board.
    return candidate.id === goal.id
  })
  const status = g?.status ?? 'done'
  console.log(`${new Date().toLocaleTimeString()} ${status} ${g ? g.tasks.map((task) => {
    // Print concise per-task progress alongside the goal status.
    return `${task.title}=${task.status}`
  }).join(', ') : ''}`)
  if (status === 'done') {
    console.log((await call('GET', `/status?goal=${goal.id}`)).text)
    process.exit(0)
  }
  if (status === 'paused') {
    console.error('The goal paused — see the board or events.jsonl.')
    process.exit(1)
  }
}
console.error('Timed out.')
process.exit(1)
