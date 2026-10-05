import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function relayEnvironment(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const url = new URL(config.url)
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' ||
      url.pathname !== '/bridge/relay' || url.username || url.password || url.search || url.hash) {
    throw new Error('The installed browser relay must connect to the local Jarvis interface')
  }
  if (!/^[a-f0-9]{48}$/.test(config.token)) throw new Error('Invalid installed relay token')
  return { JARVIS_RELAY_URL: url.href, JARVIS_RELAY_TOKEN: config.token }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    Object.assign(process.env, relayEnvironment(process.argv[2]))
    await import('./jarvis-relay.mjs')
  } catch {
    console.error('Could not start the installed browser relay. Run Jarvis setup again to repair its configuration.')
    process.exitCode = 1
  }
}