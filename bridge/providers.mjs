import OpenAI from 'openai'

export const PROVIDERS = ['claude', 'openai', 'local']

export function configuredProviders(env = process.env) {
  return PROVIDERS.filter((provider) =>
    provider === 'claude' ||
    (provider === 'openai' && Boolean(env.OPENAI_API_KEY)) ||
    (provider === 'local' && Boolean(env.JARVIS_LOCAL_URL && env.JARVIS_LOCAL_MODEL)))
}

export function textProvider(provider, env = process.env) {
  const local = provider === 'local'
  const client = new OpenAI({
    apiKey: local ? (env.JARVIS_LOCAL_API_KEY || 'local') : env.OPENAI_API_KEY,
    ...(local ? { baseURL: env.JARVIS_LOCAL_URL } : {}),
    maxRetries: 0,
  })
  const model = local ? env.JARVIS_LOCAL_MODEL : (env.OPENAI_MODEL || 'gpt-4.1-mini')

  return async function stream(messages, signal, onText, options = {}) {
    const tools = options.tools ?? []
    for (let round = 0; round < 12; round += 1) {
      const response = await client.chat.completions.create({
        model,
        messages,
        ...(tools.length ? { tools } : {}),
        // Some reasoning models reject function tools on Chat Completions
        // unless reasoning is explicitly disabled. Tool execution itself is
        // the important reasoning loop here; Responses API support can be
        // added later without changing the broker contract.
        ...(tools.length ? { reasoning_effort: 'none' } : {}),
        stream: !tools.length,
      }, { signal })

      if (!tools.length) {
        for await (const chunk of response) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) onText(delta)
        }
        return
      }

      const message = response.choices[0]?.message
      if (!message) throw new Error('The provider returned no message.')
      messages.push(message)
      if (!message.tool_calls?.length) {
        if (message.content) onText(message.content)
        return
      }

      for (const call of message.tool_calls) {
        options.onTool?.(call.function.name)
        const result = await options.callTool(call.function.name, JSON.parse(call.function.arguments || '{}'))
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
        options.onToolResult?.(call.function.name, result)
      }
    }
    throw new Error('The provider used too many tool rounds.')
  }
}

export function isCapacityError(error) {
  const message = [error?.message, error?.code, error?.type, ...(Array.isArray(error?.errors) ? error.errors : [])]
    .map((part) => typeof part === 'string' ? part : JSON.stringify(part ?? ''))
    .join(' ')
  return error?.status === 429 ||
    /insufficient_quota|billing_hard_limit|credit balance|out of credits|quota exceeded|rate.limit|usage limit|hit your limit|context.length.exceeded|token limit|\b429\b/i.test(message)
}

export function retryProvider(current, available, tried, error, activity) {
  if (activity || !isCapacityError(error)) return null
  return fallbackProvider(current, available.filter((provider) => !tried.has(provider)))
}

export function fallbackProvider(current, available) {
  return PROVIDERS.find((provider) => provider !== current && available.includes(provider)) ?? null
}