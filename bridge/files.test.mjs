import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filesServer } from './files.mjs'
import { commandsServer } from './commands.mjs'
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

test('text providers can run builds only with shell permission and a permitted cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-commands-'))
  const name = 'mcp__jarvis_commands__run_command'
  try {
    for (const allowWrites of [false, true]) {
      const broker = await createToolBroker({ local: { jarvis_commands: commandsServer({ roots: [root], allowWrites }) } })
      try {
        assert.ok(broker.tools().some((entry) => entry.function.name === name))
        const response = await broker.call(name, { command: 'printf build-ok', cwd: root }, { allow: () => allowWrites })
        assert.match(response, allowWrites ? /build-ok\nExit: 0/ : /Blocked/)
        if (allowWrites) {
          assert.match(await broker.call(name, { command: 'pwd', cwd: '/etc' }), /outside Jarvis file roots/)
          assert.match(await broker.call(name, { command: 'exit 7', cwd: root }), /Exit: 7/)
        }
      } finally {
        await broker.close()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
