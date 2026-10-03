import OpenAI from 'openai'
import { setTimeout as delay } from 'node:timers/promises'
import { endpointKey, listEndpoints } from './endpoints.mjs'

export const PROVIDERS = ['claude', 'openai', 'local']

/** The endpoints "local" can mean: everything OpenAI-compatible in the pool. */
export function localEndpoints(env = process.env) {
  return listEndpoints(env).filter((endpoint) => endpoint.kind !== 'anthropic' && endpoint.baseURL && endpoint.model)
}

/**
 * The Claude models offered beside JARVIS_MODEL. Aliases rather than dated ids,
 * so the list keeps meaning something as the installed SDK moves on. Override
 * with JARVIS_CLAUDE_MODELS (comma-separated).
 */
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku']

const csv = (raw) => String(raw ?? '').split(',').map((part) => part.trim()).filter(Boolean)
const unique = (list) => [...new Set(list.filter(Boolean))]

/**
 * What each configured provider can be asked to run, default first. Local is
 * whatever the endpoint pool serves, so picking a model there also picks which
 * boxes the turn may land on.
 */
export function providerModels(env = process.env, claudeDefault = env.JARVIS_MODEL ?? 'claude-opus-5') {
  const lists = {
    claude: unique([claudeDefault, ...(csv(env.JARVIS_CLAUDE_MODELS).length ? csv(env.JARVIS_CLAUDE_MODELS) : CLAUDE_MODELS)]),
    openai: unique([env.OPENAI_MODEL || 'gpt-4.1-mini', ...csv(env.JARVIS_OPENAI_MODELS)]),
    local: unique(localEndpoints(env).map((endpoint) => endpoint.model)),
  }
  return Object.fromEntries(configuredProviders(env).map((provider) => [provider, lists[provider]]))
}

/** The requested model if the provider offers it, otherwise its default. */
export function resolveModel(models, provider, requested) {
  const list = models[provider] ?? []
  return list.includes(requested) ? requested : list[0]
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
function targets(provider, env, model) {
  const of = (endpoint) => ({
    id: endpoint.id,
    baseURL: endpoint.baseURL,
    model: endpoint.model,
    apiKey: endpointKey(endpoint, env) || 'local',
  })
  if (provider && typeof provider === 'object') return [of(provider)]
  if (provider === 'local') {
    const pool = localEndpoints(env)
    const serving = pool.filter((endpoint) => endpoint.model === model)
    return (serving.length ? serving : pool).map(of)
  }
  return [{ id: 'openai', baseURL: null, model: model || env.OPENAI_MODEL || 'gpt-4.1-mini', apiKey: env.OPENAI_API_KEY }]
}

export function textProvider(provider, env = process.env, model) {
  const pool = targets(provider, env, model)
  if (!pool.length) throw new Error('No local endpoint is configured.')

  const turn = (target) => oneTurn(new OpenAI({
    apiKey: target.apiKey,
    ...(target.baseURL ? { baseURL: target.baseURL } : {}),
    maxRetries: 0,
  }), target.model, !target.baseURL)

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

function oneTurn(client, model, official = false) {
  return async function stream(messages, signal, onText, options = {}) {
    const tools = options.tools ?? []
    // Only api.openai.com is known to accept it; local servers may reject it.
    const cacheKey = official && options.cacheKey ? { prompt_cache_key: options.cacheKey } : {}
    for (let round = 0; round < 12; round += 1) {
      const finalRound = tools.length > 0 && round === 11
      let response
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          response = await client.chat.completions.create({
            model,
            messages: finalRound
              ? [...messages, { role: 'system', content: 'No more tools are available this turn. Summarize what was completed and what remains; do not claim unfinished work is done.' }]
              : messages,
            ...(tools.length && !finalRound ? { tools } : {}),
            // Some reasoning models reject function tools on Chat Completions
            // unless reasoning is explicitly disabled.
            ...(tools.length && !finalRound ? { reasoning_effort: 'none' } : {}),
            stream: !tools.length || finalRound,
            ...cacheKey,
          }, { signal })
          break
        } catch (error) {
          if (error.status !== 429 || error.code === 'insufficient_quota' || attempt === 2) throw error
          const milliseconds = Number(error.headers?.get('retry-after-ms'))
          const seconds = Number(error.headers?.get('retry-after'))
          await delay(Math.min(10_000, milliseconds > 0 ? milliseconds : seconds > 0 ? seconds * 1000 : 1000), undefined, { signal })
        }
      }

      if (!tools.length || finalRound) {
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