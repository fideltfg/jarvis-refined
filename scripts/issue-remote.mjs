import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const hostname = process.argv[2]?.toLowerCase()
if (!hostname || hostname.length > 253 || !hostname.includes('.') ||
    hostname.split('.').some((label) => {
      // Enforce DNS label length and syntax before creating host credentials.
      return label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    })) {
  throw new Error('Provide a dedicated DNS hostname (for example, remote-host.lan).')
}
process.umask(0o077)
const root = resolve(import.meta.dirname, '..')
const release = join(root, 'dist', 'jarvis-remote-agent')
if (!existsSync(join(release, 'remote-runtime', 'install.sh'))) {
  throw new Error('Run npm run package:remote first.')
}
const archive = join(root, 'dist', `${hostname}.tar.gz`)
const certCopy = join(root, 'dist', `${hostname}.cert.pem`)
const tokenCopy = join(root, 'dist', `${hostname}.token`)
for (const file of [archive, certCopy, tokenCopy, `${archive}.sha256`]) {
  if (existsSync(file)) throw new Error(`${file} already exists; refusing to replace host credentials.`)
}

const stage = mkdtempSync(join(tmpdir(), 'jarvis-remote-'))
try {
  // The key travels only in this host-specific archive; the main service keeps the cert and token.
  const bundle = join(stage, 'jarvis-remote-agent')
  cpSync(release, bundle, { recursive: true })
  const bootstrap = join(bundle, 'bootstrap')
  mkdirSync(bootstrap, { mode: 0o700 })
  const key = join(bootstrap, 'key.pem')
  const cert = join(bootstrap, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '365',
    '-keyout', key, '-out', cert, '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`],
  { stdio: 'ignore' })
  writeFileSync(join(bootstrap, 'hostname'), hostname + '\n', { mode: 0o600 })
  writeFileSync(join(bootstrap, 'token'), randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  execFileSync('tar', ['-czf', archive, '-C', stage, 'jarvis-remote-agent'])
  cpSync(cert, certCopy)
  cpSync(join(bootstrap, 'token'), tokenCopy)
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(`${archive}.sha256`, `${digest}  ${hostname}.tar.gz\n`, { mode: 0o600 })
  console.log(`Host-specific archive: ${archive}\nMain-host trust certificate: ${certCopy}\nMain-host token: ${tokenCopy}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}