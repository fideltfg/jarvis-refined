export async function waitForInterruptedTurn(session, stopped, timeoutMs = 10_000) {
  let timer
  try {
    await Promise.race([
      Promise.all([session.interrupt(), stopped]),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Claude did not finish interrupting the previous turn.')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function isTurnProgress(msg) {
  return msg.type === 'tool_progress' ||
    (msg.type === 'system' && ['api_retry', 'status'].includes(msg.subtype)) ||
    (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' &&
      ['thinking_delta', 'input_json_delta'].includes(msg.event.delta?.type))
}