import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryServer } from './memory.mjs'
import { createToolBroker } from './tool-broker.mjs'

test('broker discovers and calls an in-process Jarvis MCP tool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-broker-'))
  const broker = await createToolBroker({
    local: { jarvis_memory: memoryServer(join(directory, 'pa.md')) },
  })
  try {
    const names = broker.tools().map((tool) => tool.function.name)
    assert.ok(names.includes('mcp__jarvis_memory__pa_read'))
    const result = await broker.call('mcp__jarvis_memory__pa_read', {})
    assert.match(result, /# JARVIS .* PA memory/)
  } finally {
    await broker.close()
    await rm(directory, { recursive: true, force: true })
  }
})
