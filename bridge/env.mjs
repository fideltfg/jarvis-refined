import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultConfigPath, loadSettingsFile } from './settings.mjs'

export function loadEnvFile(path, { quiet = false, env = process.env, readFile = readFileSync } = {}) {
  try {
    const text = readFile(path, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!match || env[match[1]] !== undefined) continue
      let value = match[2]
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      env[match[1]] = value
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && !quiet) console.warn(`[jarvis] could not read ${path}:`, error)
  }
}

// Earlier sources win: process env, then secrets, then config.toml, then the legacy project file.
const secretsPath = join(homedir(), '.config', 'jarvis', 'secrets.env')
try {
  if (process.platform !== 'win32' && statSync(secretsPath).mode & 0o077) {
    console.warn(`[jarvis] ${secretsPath} is readable by other users; run: chmod 600 ${secretsPath}`)
  }
} catch {}
loadEnvFile(secretsPath)
loadSettingsFile(defaultConfigPath())
loadEnvFile('.env.local')