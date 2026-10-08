import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'

export const CONFIG_DIR = join(homedir(), '.config', 'jarvis')
export const defaultConfigPath = (env = process.env) => env.JARVIS_CONFIG_FILE || join(CONFIG_DIR, 'config.toml')

// Only these reach the browser bundle, so nothing secret may be added here.
export const FRONTEND_KEYS = {
  theme: 'VITE_THEME',
  backend: 'VITE_BACKEND',
  bridge_url: 'VITE_BRIDGE_URL',
  tts_engine: 'VITE_TTS_ENGINE',
  kokoro_voice: 'VITE_KOKORO_VOICE',
  use_elevenlabs: 'VITE_USE_ELEVENLABS',
  elevenlabs_voice_id: 'VITE_ELEVENLABS_VOICE_ID',
  model: 'VITE_MODEL',
  fast_mode: 'VITE_FAST_MODE',
  mcp_servers: 'VITE_MCP_SERVERS',
}

export const BRIDGE_KEYS = {
  bridge_port: 'JARVIS_BRIDGE_PORT',
  face_port: 'PORT',
  host: 'JARVIS_HOST',
  tls_cert: 'JARVIS_TLS_CERT',
  tls_key: 'JARVIS_TLS_KEY',
  model: 'JARVIS_MODEL',
  claude_models: 'JARVIS_CLAUDE_MODELS',
  effort: 'JARVIS_EFFORT',
  max_turns: 'JARVIS_MAX_TURNS',
  provider: 'JARVIS_PROVIDER',
  openai_model: 'OPENAI_MODEL',
  openai_models: 'JARVIS_OPENAI_MODELS',
  openai_transcribe_model: 'OPENAI_TRANSCRIBE_MODEL',
  local_url: 'JARVIS_LOCAL_URL',
  local_model: 'JARVIS_LOCAL_MODEL',
  endpoints: 'JARVIS_ENDPOINTS',
  debug: 'JARVIS_DEBUG',
  allow_writes: 'JARVIS_ALLOW_WRITES',
  allowed_origins: 'JARVIS_ALLOWED_ORIGINS',
  allow_no_origin: 'JARVIS_ALLOW_NO_ORIGIN',
  file_roots: 'JARVIS_FILE_ROOTS',
  memory_file: 'JARVIS_MEMORY_FILE',
  history_file: 'JARVIS_HISTORY_FILE',
  session_agents_file: 'JARVIS_SESSION_AGENTS_FILE',
  conversations_dir: 'JARVIS_CONVERSATIONS_DIR',
  loose_ends_file: 'JARVIS_LOOSE_ENDS_FILE',
  voice_id: 'JARVIS_VOICE_ID',
  agents: 'JARVIS_AGENTS',
  agents_port: 'JARVIS_AGENTS_PORT',
  agents_host: 'JARVIS_AGENTS_HOST',
  agents_tls_cert: 'JARVIS_AGENTS_TLS_CERT',
  agents_tls_key: 'JARVIS_AGENTS_TLS_KEY',
  agents_tls_ca: 'JARVIS_AGENTS_TLS_CA',
  agents_dir: 'JARVIS_AGENTS_DIR',
  agents_sonnet: 'JARVIS_AGENTS_SONNET',
  agents_opus: 'JARVIS_AGENTS_OPUS',
  host_label: 'JARVIS_HOST_LABEL',
  work_dir: 'JARVIS_WORK_DIR',
  max_workers: 'JARVIS_MAX_WORKERS',
  project_roots: 'JARVIS_PROJECT_ROOTS',
  remote_model: 'JARVIS_REMOTE_MODEL',
  remote_model_url: 'JARVIS_REMOTE_MODEL_URL',
  remote_workers: 'JARVIS_REMOTE_WORKERS',
  auto_compact_window: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
}

const SECTIONS = { frontend: FRONTEND_KEYS, bridge: BRIDGE_KEYS }
const SECRET_NAME = /(key|token|secret|password|credential)s?$/i

function stringify(name, value) {
  if (typeof value === 'boolean') return name.startsWith('VITE_') ? String(value) : value ? '1' : '0'
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'object' && item !== null)
      ? JSON.stringify(value)
      : value.join(',')
  }
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

/** Flatten a parsed config.toml into environment variables. */
export function settingsToEnv(parsed) {
  const env = {}
  const warnings = []
  for (const [section, table] of Object.entries(parsed ?? {})) {
    const keys = SECTIONS[section]
    if (!keys || typeof table !== 'object' || table === null || Array.isArray(table)) {
      warnings.push(`unknown section [${section}] ignored (supported: ${Object.keys(SECTIONS).join(', ')})`)
      continue
    }
    for (const [key, value] of Object.entries(table)) {
      if (SECRET_NAME.test(key) && !(key in keys)) {
        warnings.push(`${section}.${key} looks like a credential; put it in secrets.env, not config.toml`)
      } else if (!(key in keys)) {
        warnings.push(`unknown setting ${section}.${key} ignored`)
      } else {
        env[keys[key]] = stringify(keys[key], value)
      }
    }
  }
  return { env, warnings }
}

/** Load config.toml into `env` without overriding variables that are already set. */
export function loadSettingsFile(path, { quiet = false, env = process.env, readFile = readFileSync } = {}) {
  let parsed
  try {
    parsed = parse(readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[jarvis] could not read ${path}:`, error?.message ?? error)
    return false
  }
  const { env: values, warnings } = settingsToEnv(parsed)
  if (!quiet) for (const warning of warnings) console.warn(`[jarvis] ${path}: ${warning}`)
  for (const [name, value] of Object.entries(values)) if (env[name] === undefined) env[name] = value
  return true
}
