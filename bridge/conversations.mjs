import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export function createConversationStore({
  directory = process.env.JARVIS_CONVERSATIONS_DIR || join(homedir(), '.config', 'jarvis', 'conversations'),
  onError = (error) => console.warn('[jarvis] conversation checkpoint failed:', error.message),
} = {}) {
  const owners = new Map()
  return {
    open(requestedId, theme, onReplace = () => {}) {
      const valid = typeof requestedId === 'string' && UUID.test(requestedId)
      let id = valid ? requestedId : randomUUID()
      let path = join(directory, `${id}.json`)
      const previous = owners.get(id)
      if (previous?.state.theme === theme) previous.onReplace()
      let state = null
      try {
        if (valid) {
          const saved = JSON.parse(readFileSync(path, 'utf8'))
          if (saved.theme === theme && Array.isArray(saved.messages) && Array.isArray(saved.missedClaude)) {
            state = saved
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') onError(error)
      }
      const restored = state !== null
      if (valid && !restored) {
        id = randomUUID()
        path = join(directory, `${id}.json`)
      }
      state ??= { theme, messages: [], missedClaude: [], claudeSessionId: null, claudePrimed: false, pending: null }
      const lease = {
        id,
        state,
        restored,
        unavailable: valid && !restored,
        onReplace,
        save() {
          if (owners.get(id) !== lease) return false
          const temporary = `${path}.${randomUUID()}.tmp`
          try {
            mkdirSync(directory, { recursive: true, mode: 0o700 })
            writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
            renameSync(temporary, path)
            return true
          } catch (error) {
            onError(error)
            return false
          } finally {
            try { rmSync(temporary, { force: true }) } catch {}
          }
        },
        release() {
          if (owners.get(id) === lease) owners.delete(id)
        },
      }
      owners.set(id, lease)
      return lease
    },
  }
}

export function claudeRecoveryOptions(state) {
  return {
    persistSession: true,
    ...(typeof state.claudeSessionId === 'string' && UUID.test(state.claudeSessionId)
      ? { resume: state.claudeSessionId } : {}),
  }
}

export function interruptedContext(pending) {
  if (!pending) return ''
  return `The connection was interrupted during this request: ${pending.question}\n` +
    `${pending.partial ? `Partial answer: ${pending.partial}\n` : ''}` +
    'The request may have performed actions already. Do not repeat or continue it automatically; ' +
    'use it only as conversation context and respond to the new request.\n\n'
}

export function historyMessages(turns) {
  if (!Array.isArray(turns) || turns.length < 1 || turns.length > 400 ||
      Buffer.byteLength(JSON.stringify(turns)) > 2_000_000) {
    throw new Error('The saved conversation is empty or too large to reopen.')
  }
  return turns.map((turn) => {
    if (!turn || !['user', 'jarvis'].includes(turn.role) || typeof turn.text !== 'string') {
      throw new Error('The saved conversation contains an invalid turn.')
    }
    const names = Array.isArray(turn.attachments)
      ? turn.attachments.map((file) => typeof file?.name === 'string' ? file.name : '').filter(Boolean) : []
    return {
      role: turn.role === 'user' ? 'user' : 'assistant',
      content: turn.text + (names.length ? `\n[Previously attached files: ${names.join(', ')}; file contents are not available.]` : ''),
    }
  })
}