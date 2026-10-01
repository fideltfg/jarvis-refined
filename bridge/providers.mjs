import OpenAI from 'openai'
import { endpointKey, listEndpoints } from './endpoints.mjs'

export const PROVIDERS = ['claude', 'openai', 'local']

/** The endpoints "local" can mean: everything OpenAI-compatible in the pool. */
export function localEndpoints(env = process.env) {
  return listEndpoints(env).filter((endpoint) => endpoint.kind !== 'anthropic' && endpoint.baseURL && endpoint.model)
}

export function configuredProviders(env = process.env) {
  return PROVIDERS.filter((provider) =>
    provider === 'claude' ||
    (provider === 'openai' && Boolean(env.OPENAI_API_KEY)) ||
    (provider === 'local' && localEndpoints(env).length > 0))
}

/**
 * Which machines a call may land on, in preference order. An endpoint object
 * pins the call to that one box; "local" spreads across the pool, so a
 * saturated endpoint hands the turn to the next one instead of failing it.
 */
function targets(provider, env) {
  const of = (endpoint) => ({
    id: endpoint.id,
    baseURL: endpoint.baseURL,
    model: endpoint.model,
    apiKey: endpointKey(endpoint, env) || 'local',
  })
  if (provider && typeof provider === 'object') return [of(provider)]
  if (provider === 'local') return localEndpoints(env).map(of)
  return [{ id: 'openai', baseURL: null, model: env.OPENAI_MODEL || 'gpt-4.1-mini', apiKey: env.OPENAI_API_KEY }]
}

export function textProvider(provider, env = process.env) {
  const pool = targets(provider, env)
  if (!pool.length) throw new Error('No local endpoint is configured.')

  const turn = (target) => oneTurn(new OpenAI({
    apiKey: target.apiKey,
    ...(target.baseURL ? { baseURL: target.baseURL } : {}),
    maxRetries: 0,
  }), target.model)

  return async function stream(messages, signal, onText, options = {}) {
    // Words already spoken cannot be unspoken, so once anything has been
    // emitted the turn belongs to that endpoint, saturated or not.
    let emitted = false
    const depth = messages.length
    const emit = (text) => {
      emitted = true
      onText(text)
    }
    for (const [index, target] of pool.entries()) {
      try {
        return await turn(target)(messages, signal, emit, options)
      } catch (err) {
        if (emitted || index === pool.length - 1 || !isCapacityError(err)) throw err
        messages.length = depth
      }
    }
  }
}

function oneTurn(client, model) {
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