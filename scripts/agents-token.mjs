import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The bridge and the agent service share one secret, kept where both systemd
 * units already read their environment. Idempotent: an existing token is kept.
 */
const file = join(homedir(), '.config', 'jarvis', 'secrets.env')
mkdirSync(dirname(file), { recursive: true })
const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
if (/^JARVIS_AGENTS_TOKEN=/m.test(text)) {
  console.log(`JARVIS_AGENTS_TOKEN is already set in ${file}.`)
} else {
  const lead = text && !text.endsWith('\n') ? '\n' : ''
  appendFileSync(file, `${lead}JARVIS_AGENTS_TOKEN=${randomBytes(24).toString('hex')}\n`)
  chmodSync(file, 0o600)
  console.log(`Added JARVIS_AGENTS_TOKEN to ${file}.`)
}
