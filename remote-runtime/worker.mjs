/** Validate and normalize the configured loopback OpenAI-compatible endpoint. */
export function localModelURL(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('JARVIS_REMOTE_MODEL_URL must be a loopback HTTP(S) URL ending in /v1.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1')) {
    throw new Error('JARVIS_REMOTE_MODEL_URL must be a loopback HTTP(S) URL ending in /v1.')
  }
  return url.href.replace(/\/$/, '')
}

/** Execute one text-only research task within its cancellation and time budget. */
export async function runTask(task, { store, signal, modelURL, model, fetchFn = fetch }) {
  if (signal?.aborted) return { status: 'cancelled', failure: { reason: 'cancelled', detail: 'Stopped by the user.' } }
  if (task.kind === 'ops') {
    return { status: 'blocked', failure: { reason: 'blocked', detail: 'Remote ops has no service integrations.', blocker: 'dependency', need: ['An explicitly configured local service integration'] } }
  }
  const goal = store.getGoal(task.goalId)
  const controller = new AbortController()
  /** Forward upstream cancellation to the in-flight model request. */
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, task.budget.maxMinutes * 60_000)
  try {
    const response = await fetchFn(`${localModelURL(modelURL)}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [
        { role: 'system', content: 'You are a local, text-only research assistant. You have no browsing, tools or service access. Do not claim to have verified external facts or taken actions. If the task needs unavailable information, explain what is missing.' },
        { role: 'user', content: `Goal: ${goal?.title ?? ''}\nDesired outcome: ${goal?.outcome ?? ''}\nTask: ${task.title}\n${task.brief}` },
      ] }),
    })
    if (!response.ok) throw new Error(`Local model returned HTTP ${response.status}`)
    const data = await response.json()
    const summary = data.choices?.[0]?.message?.content
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('Local model returned no text.')
    return { status: 'done', result: { summary: summary.trim(), artifacts: [] } }
  } catch (err) {
    if (signal?.aborted) return { status: 'cancelled', failure: { reason: 'cancelled', detail: 'Stopped by the user.' } }
    if (controller.signal.aborted) return { status: 'failed', failure: { reason: 'budget', detail: 'Remote task timed out.' } }
    return { status: 'failed', failure: { reason: 'error', detail: err.message } }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}