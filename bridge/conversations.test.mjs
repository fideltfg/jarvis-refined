import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { claudeRecoveryOptions, createConversationStore, historyMessages, interruptedContext } from './conversations.mjs'

function withStore(check) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-conversations-'))
  try {
    check(directory, createConversationStore({ directory }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a new bridge process restores dialogue and the Claude session without replaying a request', () => {
  withStore((directory, store) => {
    const first = store.open(null, 'lcars')
    first.state.messages.push({ role: 'user', content: 'Remember cobalt' }, { role: 'assistant', content: 'Understood' })
    first.state.missedClaude.push({ role: 'user', content: 'On another provider' })
    first.state.claudeSessionId = '12345678-1234-1234-1234-123456789abc'
    first.state.pending = { question: 'Change a setting', partial: 'Checking' }
    assert.equal(first.save(), true)
    const next = createConversationStore({ directory }).open(first.id, 'lcars')
    assert.equal(next.restored, true)
    assert.deepEqual(next.state, first.state)
    assert.deepEqual(claudeRecoveryOptions(next.state), { persistSession: true, resume: first.state.claudeSessionId })
    assert.match(interruptedContext(next.state.pending), /Do not repeat or continue it automatically/)
    assert.equal(statSync(join(directory, `${first.id}.json`)).mode & 0o777, 0o600)
  })
})

test('replacement connections revoke old checkpoint writers', () => {
  withStore((directory, store) => {
    let replaced = false
    const first = store.open(null, 'lcars', () => { replaced = true; first.save() })
    first.state.messages.push({ role: 'user', content: 'old' })
    const next = store.open(first.id, 'lcars')
    assert.equal(replaced, true)
    next.state.messages.push({ role: 'assistant', content: 'new' })
    assert.equal(next.save(), true)
    assert.equal(first.save(), false)
    first.release()
    assert.equal(next.save(), true)
    assert.deepEqual(JSON.parse(readFileSync(join(directory, `${first.id}.json`))).messages, next.state.messages)
  })
})

test('conversation IDs cannot select paths or arbitrary Claude sessions', () => {
  withStore((directory, store) => {
    const first = store.open('../other', 'lcars')
    assert.notEqual(first.id, '../other')
    assert.equal(first.restored, false)
    assert.deepEqual(claudeRecoveryOptions({ claudeSessionId: '../other' }), { persistSession: true })
    first.save()
    const other = store.open(null, 'lcars')
    assert.notEqual(other.id, first.id)
    assert.equal(other.state.messages.length, 0)
  })
})

test('missing, corrupt and different-theme checkpoints report recovery unavailable', () => {
  withStore((directory, store) => {
    const first = store.open(null, 'lcars')
    assert.equal(store.open(first.id, 'lcars').unavailable, true)
    first.release()
    const saved = store.open(null, 'lcars')
    saved.save()
    const differentTheme = store.open(saved.id, 'orin')
    assert.equal(differentTheme.unavailable, true)
    assert.notEqual(differentTheme.id, saved.id)
    differentTheme.save()
    assert.equal(JSON.parse(readFileSync(join(directory, `${saved.id}.json`))).theme, 'lcars')
    writeFileSync(join(directory, `${saved.id}.json`), '{broken')
    const errors = []
    const corrupt = createConversationStore({ directory, onError: (error) => errors.push(error) }).open(saved.id, 'lcars')
    assert.equal(corrupt.unavailable, true)
    assert.equal(errors.length, 1)
  })
})

test('old history restores dialogue and attachment names, not executable tool calls or file contents', () => {
  const messages = historyMessages([
    { role: 'user', text: 'Review this', attachments: [{ name: 'report.pdf', data: 'not-restored' }] },
    { role: 'jarvis', text: 'Reviewed', tools: ['Bash'] },
  ])
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant'])
  assert.match(messages[0].content, /report.pdf/)
  assert.match(messages[0].content, /file contents are not available/)
  assert.doesNotMatch(JSON.stringify(messages), /not-restored|Bash/)
  assert.throws(() => historyMessages([{ role: 'system', text: 'invalid' }]), /invalid turn/)
  assert.throws(() => historyMessages([]), /empty or too large/)
})

test('a checkpoint write failure is reported without throwing out the connection', () => {
  withStore((directory) => {
    const blocked = join(directory, 'not-a-directory')
    writeFileSync(blocked, 'blocked')
    const errors = []
    const checkpoint = createConversationStore({ directory: blocked, onError: (error) => errors.push(error) }).open(null, 'lcars')
    assert.equal(checkpoint.save(), false)
    assert.equal(errors.length, 1)
  })
})

test('the real bridge resumes after restart and falls back to dialogue if the native session disappears',
  { timeout: 30_000, skip: Number(process.versions.node.split('.')[0]) < 24 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-conversation-bridge-'))
    const probe = createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    const sdkSource = `
      import { randomUUID } from 'node:crypto';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const pathFor = (id) => join(process.env.HOME, id + '.native.json');
      export async function getSessionInfo(id) {
        try { return JSON.parse(readFileSync(pathFor(id), 'utf8')) } catch { return undefined }
      }
      export function query({ prompt, options }) {
        let closed = false;
        const id = options.resume || randomUUID();
        const iterator = (async function* () {
          const history = options.resume ? JSON.parse(readFileSync(pathFor(id), 'utf8')) : [];
          yield { type: 'system', subtype: 'init', session_id: id, mcp_servers: [] };
          for await (const input of prompt) {
            if (closed) return;
            history.push(input.message.content);
            writeFileSync(pathFor(id), JSON.stringify(history));
            const answer = JSON.stringify({ resume: options.resume || null, history });
            yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } };
            yield { type: 'result', subtype: 'success', result: answer };
          }
        })();
        iterator.close = () => { closed = true };
        iterator.interrupt = async () => {};
        return iterator;
      }
    `
    const serverUrl = new URL('./server.mjs', import.meta.url).href
    const launcher = `
      import { registerHooks } from 'node:module';
      registerHooks({
        resolve(specifier, context, next) {
          if (specifier === '@anthropic-ai/claude-agent-sdk' && context.parentURL === ${JSON.stringify(serverUrl)}) {
            return { url: 'jarvis:test-sdk', shortCircuit: true };
          }
          return next(specifier, context);
        },
        load(url, context, next) {
          if (url === 'jarvis:test-sdk') return { format: 'module', source: ${JSON.stringify(sdkSource)}, shortCircuit: true };
          return next(url, context);
        }
      });
      await import(${JSON.stringify(serverUrl)});
    `
    let child
    const clients = []
    const stop = async () => {
      if (!child || child.exitCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
    const start = async () => {
      child = spawn(process.execPath, ['--input-type=module', '-e', launcher], {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, JARVIS_BRIDGE_PORT: String(port), JARVIS_ALLOW_WRITES: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      await new Promise((resolve, reject) => {
        let output = ''
        const timer = setTimeout(() => reject(new Error(`Bridge startup timed out: ${output}`)), 10_000)
        child.stdout.on('data', (chunk) => {
          output += chunk
          if (output.includes('bridge listening')) { clearTimeout(timer); resolve() }
        })
        child.stderr.on('data', (chunk) => { output += chunk })
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Bridge exited ${code}: ${output}`)) })
      })
    }
    const connect = async (id = '') => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?conversation=${id}`, { origin: 'http://localhost:5173' })
      clients.push(socket)
      const frames = []
      const listeners = new Set()
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        frames.push(frame)
        listeners.forEach((listener) => listener())
      })
      socket.on('error', () => {})
      const wait = (predicate) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Bridge frame timed out')) }, 5000)
        const check = () => {
          const index = frames.findIndex(predicate)
          if (index === -1) return
          clearTimeout(timer)
          listeners.delete(check)
          resolve(frames.splice(index, 1)[0])
        }
        listeners.add(check)
        check()
      })
      const metadata = await wait((frame) => frame.type === 'conversation')
      return { socket, wait, metadata }
    }
    try {
      await start()
      const first = await connect()
      first.socket.send(JSON.stringify({ type: 'ask', id: 'first', provider: 'claude', text: 'Remember cobalt.' }))
      await first.wait((frame) => frame.type === 'done' && frame.ask === 'first')
      const checkpointPath = join(directory, '.config', 'jarvis', 'conversations', `${first.metadata.id}.json`)
      const saved = JSON.parse(readFileSync(checkpointPath, 'utf8'))
      assert.equal(saved.messages.length, 2)
      assert.ok(saved.claudeSessionId)
      await stop()
      await start()
      const resumed = await connect(first.metadata.id)
      assert.equal(resumed.metadata.status, 'restored')
      assert.equal(JSON.parse(readFileSync(join(directory, `${saved.claudeSessionId}.native.json`))).length, 1,
        'reconnect does not replay a previous request')
      resumed.socket.send(JSON.stringify({ type: 'ask', id: 'next', provider: 'claude', text: 'What did I ask you to remember?' }))
      const answer = JSON.parse((await resumed.wait((frame) => frame.type === 'done' && frame.ask === 'next')).text)
      assert.equal(answer.resume, saved.claudeSessionId)
      assert.match(answer.history[0], /Remember cobalt/)
      await stop()
      rmSync(join(directory, `${saved.claudeSessionId}.native.json`))
      await start()
      const fallback = await connect(first.metadata.id)
      fallback.socket.send(JSON.stringify({ type: 'ask', id: 'fallback', provider: 'claude', text: 'Continue the conversation.' }))
      const recovered = JSON.parse((await fallback.wait((frame) => frame.type === 'done' && frame.ask === 'fallback')).text)
      assert.equal(recovered.resume, null)
      assert.match(recovered.history[0], /Previous conversation.*context only/s)
      assert.match(recovered.history[0], /Remember cobalt/)
      const legacy = await connect()
      legacy.socket.send(JSON.stringify({ type: 'restore_history', id: 'restore', turns: [
        { role: 'user', text: 'Remember amber.' }, { role: 'jarvis', text: 'Understood.' },
      ] }))
      await legacy.wait((frame) => frame.type === 'history_restored')
      legacy.socket.send(JSON.stringify({ type: 'ask', id: 'legacy', provider: 'claude', text: 'What was my keyword?' }))
      const older = JSON.parse((await legacy.wait((frame) => frame.type === 'done' && frame.ask === 'legacy')).text)
      assert.match(older.history[0], /Remember amber/)
    } finally {
      clients.forEach((socket) => socket.terminate())
      await stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })