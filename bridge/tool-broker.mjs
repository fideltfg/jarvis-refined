import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const CLIENT_INFO = { name: 'jarvis-provider-broker', version: '1.0.0' }

function openTransport(config) {
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) },
      cwd: config.cwd,
      stderr: 'pipe',
    })
  }

  const url = new URL(config.url)
  const headers = {
    ...(config.headers ?? {}),
    ...(config.authorization_token ? { Authorization: `Bearer ${config.authorization_token}` } : {}),
  }
  const requestInit = Object.keys(headers).length ? { headers } : undefined
  if (config.type === 'sse') return new SSEClientTransport(url, { requestInit })
  return new StreamableHTTPClientTransport(url, { requestInit })
}

function asOpenAiTool(server, tool) {
  const name = `mcp__${server}__${tool.name}`
  return {
    type: 'function',
    function: {
      name,
      description: tool.description ?? `Call ${tool.name} on ${server}.`,
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  }
}

function resultText(result) {
  if (!result) return 'The tool returned no result.'
  if (result.isError) return `Tool error: ${result.content?.map((part) => part.text ?? '').join('\n') || 'unknown error'}`
  return result.content?.map((part) => part.type === 'text' ? part.text : JSON.stringify(part)).join('\n') || 'The tool completed without a text result.'
}

/** Provider-neutral MCP discovery and execution. */
export async function createToolBroker({ external = {}, local = {} }) {
  const entries = new Map()
  const connections = []

  async function addClient(server, client, transport, close = () => client.close()) {
    await client.connect(transport)
    const listed = await client.listTools()
    for (const tool of listed.tools ?? []) {
      entries.set(`mcp__${server}__${tool.name}`, {
        server,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        client,
      })
    }
    connections.push(close)
  }

  for (const [server, config] of Object.entries(external)) {
    try {
      const client = new Client(CLIENT_INFO)
      await addClient(server, client, openTransport(config))
    } catch (error) {
      console.warn(`[jarvis] MCP broker could not connect to ${server}: ${error.message}`)
    }
  }

  for (const [server, config] of Object.entries(local)) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client(CLIENT_INFO)
    await config.instance.connect(serverTransport)
    await addClient(server, client, clientTransport, async () => {
      await client.close()
      await config.instance.close?.()
    })
  }

  return {
    tools() {
      return [...entries].map(([, entry]) => asOpenAiTool(entry.server, entry))
    },
    async call(name, args, { allow = () => true } = {}) {
      const entry = entries.get(name)
      if (!entry) return 'Unknown tool.'
      if (!allow(name)) return 'Blocked: this tool is not permitted in the current mode.'
      return resultText(await entry.client.callTool({ name: entry.name, arguments: args ?? {} }))
    },
    async close() {
      for (const close of connections.splice(0)) {
        try { await close() } catch { /* server already closed */ }
      }
    },
  }
}

export { asOpenAiTool, resultText }
