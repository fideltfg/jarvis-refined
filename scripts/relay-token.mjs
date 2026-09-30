import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The secret a browser relay presents to the bridge, kept where the systemd
 * unit already reads its environment. Idempotent: an existing token is kept.
 * It is printed because the relay runs on another machine and needs it typed
 * or pasted there.
 */
const file = join(homedir(), '.config', 'jarvis', 'secrets.env')
mkdirSync(dirname(file), { recursive: true })
const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
let token = /^JARVIS_RELAY_TOKEN=(.+)$/m.exec(text)?.[1]
if (token) {
  console.log(`JARVIS_RELAY_TOKEN is already set in ${file}.`)
} else {
  token = randomBytes(24).toString('hex')
  const lead = text && !text.endsWith('\n') ? '\n' : ''
  appendFileSync(file, `${lead}JARVIS_RELAY_TOKEN=${token}\n`)
  chmodSync(file, 0o600)
  console.log(`Added JARVIS_RELAY_TOKEN to ${file}. Restart the bridge to pick it up.`)
}
console.log(`\nOn the machine with Chrome:\n  node jarvis-relay.mjs wss://<server>:5173/bridge/relay --token ${token}`)
