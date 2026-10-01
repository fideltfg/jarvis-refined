import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const source = resolve(import.meta.dirname, '..')
const dest = resolve(process.argv[2] ?? join(source, 'dist', 'jarvis-remote-agent'))
if (dest === source || !dest.startsWith(source + '/')) throw new Error('Package output must be inside this repository.')
const stage = mkdtempSync(join(tmpdir(), 'jarvis-remote-'))
const files = ['remote-runtime/api.mjs', 'remote-runtime/service.mjs', 'remote-runtime/worker.mjs', 'remote-runtime/install.sh',
  ...['approvals', 'config', 'pool', 'recover', 'scheduler', 'store'].map((name) => `agents/${name}.mjs`),
  'bridge/endpoints.mjs', 'LICENSE']
try {
  for (const file of files) {
    const target = join(stage, file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(source, file), target)
  }
  cpSync(join(source, 'deploy/jarvis-remote-agent.service'), join(stage, 'jarvis-remote-agent.service'))
  const root = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const pkg = { name: 'jarvis-remote-agent', version: root.version, private: true, type: 'module',
    engines: { node: '>=20' }, scripts: { start: 'node remote-runtime/service.mjs' } }
  writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' })
  // Never mix a previous package into the release.
  if (existsSync(dest)) rmSync(dest, { recursive: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(stage, dest, { recursive: true })
  console.log(`Remote runtime packaged at ${dest}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
