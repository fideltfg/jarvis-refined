#!/usr/bin/env node
// Split a legacy .env.local (and service.env) into config.toml (non-secret) and secrets.env (credentials).
// Usage: node scripts/migrate-config.mjs [--env FILE]... [--retire] [--force]
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stringify } from 'smol-toml'
import { BRIDGE_KEYS, CONFIG_DIR, FRONTEND_KEYS, defaultConfigPath } from '../bridge/settings.mjs'

const BOOLEAN = new Set(['allow_writes', 'allow_no_origin', 'debug', 'agents', 'fast_mode'])
const NUMBER = new Set(['bridge_port', 'face_port', 'max_turns', 'auto_compact_window', 'agents_port', 'max_workers', 'remote_workers'])
const LIST = new Set(['claude_models', 'openai_models', 'allowed_origins', 'file_roots', 'project_roots'])

export function parseEnv(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out.push([match[1], value])
  }
  return out
}

function convert(key, value) {
  if (BOOLEAN.has(key) && /^(1|true|0|false)$/i.test(value)) return /^(1|true)$/i.test(value)
  if (NUMBER.has(key) && /^\d+$/.test(value)) return Number(value)
  if (LIST.has(key)) return value.split(',').map((item) => item.trim()).filter(Boolean)
  if (key === 'endpoints' || key === 'mcp_servers') {
    if (value.trim().startsWith('[')) {
      try { return JSON.parse(value) } catch { return value }
    }
    return value
  }
  if (key === 'use_elevenlabs' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true'
  return value
}

/** Sort env entries into config sections and secret/unrecognised lines. Earlier entries win. */
export function split(entries) {
  const frontend = Object.fromEntries(Object.entries(FRONTEND_KEYS).map(([key, name]) => [name, key]))
  const bridge = Object.fromEntries(Object.entries(BRIDGE_KEYS).map(([key, name]) => [name, key]))
  const config = {}
  const secrets = []
  const seen = new Set()
  for (const [name, value] of entries) {
    if (seen.has(name)) continue
    seen.add(name)
    if (!(name in frontend || name in bridge)) {
      secrets.push([name, value])
      continue
    }
    const section = name in frontend ? 'frontend' : 'bridge'
    const key = section === 'frontend' ? frontend[name] : bridge[name]
    ;(config[section] ??= {})[key] = convert(key, value)
  }
  return { config, secrets }
}

function main() {
  const args = process.argv.slice(2)
  const files = []
  for (let i = 0; i < args.length; i++) if (args[i] === '--env') files.push(args[++i])
  if (files.length === 0) files.push('.env.local', join(CONFIG_DIR, 'service.env'))
  const retire = args.includes('--retire')
  const target = defaultConfigPath()
  if (existsSync(target) && !args.includes('--force')) {
    console.error(`${target} already exists; pass --force to overwrite it.`)
    process.exit(1)
  }
  const present = files.filter((file) => existsSync(file))
  if (present.length === 0) {
    console.error(`Nothing to migrate: none of ${files.join(', ')} exist.`)
    process.exit(1)
  }
  const { config, secrets } = split(present.flatMap((file) => parseEnv(readFileSync(file, 'utf8'))))

  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `# JARVIS settings (non-secret). Credentials belong in secrets.env.\n${stringify(config)}\n`)
  console.log(`wrote ${target}`)

  const secretsPath = join(CONFIG_DIR, 'secrets.env')
  const existing = existsSync(secretsPath) ? readFileSync(secretsPath, 'utf8') : ''
  const have = new Set(parseEnv(existing).map(([name]) => name))
  const fresh = secrets.filter(([name]) => !have.has(name))
  if (fresh.length > 0) {
    appendFileSync(secretsPath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${fresh.map(([name, value]) => `${name}=${value}`).join('\n')}\n`)
    console.log(`appended ${fresh.map(([name]) => name).join(', ')} to ${secretsPath}`)
  }
  if (existsSync(secretsPath)) chmodSync(secretsPath, 0o600)

  for (const file of present) {
    if (retire) {
      renameSync(file, `${file}.migrated`)
      console.log(`retired ${file} -> ${file}.migrated (delete it once you have checked the result)`)
    }
  }
  if (!retire) console.log('Original files left in place; rerun with --retire to rename them.')
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main()
