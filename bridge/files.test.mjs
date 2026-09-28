import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filesServer } from './files.mjs'
import { createToolBroker } from './tool-broker.mjs'

test('shared file tools read and search only within configured roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-files-'))
  await writeFile(join(root, 'note.txt'), 'alpha\nbeta\n')
  const broker = await createToolBroker({ local: { jarvis_files: filesServer({ roots: [root], allowWrites: false }) } })
  try {
    const names = broker.tools().map((tool) => tool.function.name)
    assert.ok(names.includes('mcp__jarvis_files__fs_read'))
    assert.match(await broker.call('mcp__jarvis_files__fs_read', { path: join(root, 'note.txt') }), /alpha/)
    assert.match(await broker.call('mcp__jarvis_files__fs_search', { path: root, query: 'beta' }), /note\.txt:2/)
    assert.match(await broker.call('mcp__jarvis_files__fs_read', { path: '/etc/passwd' }), /outside Jarvis file roots/)
    assert.match(await broker.call('mcp__jarvis_files__fs_write', { path: join(root, 'blocked.txt'), content: 'no' }), /disabled/)
  } finally {
    await broker.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('shared file tools can write only when enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-files-'))
  const broker = await createToolBroker({ local: { jarvis_files: filesServer({ roots: [root], allowWrites: true }) } })
  try {
    const path = join(root, 'created.txt')
    assert.match(await broker.call('mcp__jarvis_files__fs_write', { path, content: 'created' }), /Wrote/)
    assert.equal(await readFile(path, 'utf8'), 'created')
  } finally {
    await broker.close()
    await rm(root, { recursive: true, force: true })
  }
})
