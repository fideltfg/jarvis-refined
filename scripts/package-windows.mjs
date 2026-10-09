import { createHash } from 'node:crypto'
import { createReadStream, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const windowsPrerequisites = [
  { id: 'wsl', minimumVersion: 2 },
  { id: 'linuxDistribution', name: 'Ubuntu-24.04', dedicated: true },
  { id: 'windowsNode', minimumMajor: 22 },
  { id: 'linuxNode', minimumMajor: 22 },
]

/** Remove build-time and credential variables from child release environments. */
export function releaseEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => {
    // Keep release builds independent of local providers and secrets.
    return !/^(VITE_|JARVIS_|ANTHROPIC_|OPENAI_|ELEVENLABS_|PICOVOICE_)/i.test(name)
  }))
}

/** Stream a file into SHA-256 and return its lowercase hexadecimal digest. */
export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Exclude hidden, test, and credential files from packaged release inputs. */
export function releaseFilter(source) {
  const normalized = source.replaceAll('\\', '/')
  const name = normalized.split('/').at(-1)
  return !name.startsWith('.') && !name.endsWith('.test.mjs') &&
    !/\.(?:env|pem|key|pfx|p12)$/i.test(name) && name !== 'secrets.json'
}

/** Publish a completed release directory atomically at a new output path. */
export function publishRelease(directory, output) {
  const parent = resolve(output, '..')
  mkdirSync(parent, { recursive: true })
  const stage = mkdtempSync(join(parent, '.jarvis-release-'))
  try {
    cpSync(directory, stage, { recursive: true })
    if (existsSync(output)) throw new Error('Output directory already exists')
    renameSync(stage, output)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** Build the Windows installer payload from a clean, filtered staging tree. */
export async function packageWindows(argv = process.argv.slice(2)) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Use --output <new-directory>')
    }
    if (!['--output'].includes(argv[index])) {
      throw new Error(`Unknown option: ${argv[index]}`)
    }
    options.set(argv[index], argv[index + 1])
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build the WSL x64 payload on Linux x64')
  const source = resolve(import.meta.dirname, '..')
  const output = resolve(options.get('--output') ?? join(source, 'dist', 'windows-installer'))
  if (source.startsWith(output + '/') || output === source || existsSync(output)) {
    throw new Error('Output must be a new directory, not the repository or an ancestor')
  }
  const stage = mkdtempSync(join(tmpdir(), 'jarvis-windows-'))
  const build = join(stage, 'build')
  const app = join(stage, 'app')
  const result = join(stage, 'result')
  const environment = releaseEnvironment(process.env)
  /** Copy a source path while applying the release file allowlist. */
  const copy = (from, to) => cpSync(from, to, { recursive: true, filter: releaseFilter })
  try {
    mkdirSync(build)
    mkdirSync(app)
    mkdirSync(result)
    // Copy only app inputs needed to build the browser bundle.
    for (const name of ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts',
      'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'src', 'public']) {
      copy(join(source, name), join(build, name))
    }
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: build, env: environment, stdio: 'inherit' })
    copy(join(build, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'), join(build, 'public', 'mediapipe'))
    execFileSync('npm', ['run', 'build'], { cwd: build, stdio: 'inherit',
      env: { ...environment, VITE_BACKEND: 'bridge', VITE_BRIDGE_URL: '/bridge' } })
    // Assemble the runtime payload with production dependencies and deployment files.
    for (const name of ['bridge', 'agents', 'remote-runtime', 'scripts', 'deploy', 'LICENSE', 'package.json', 'package-lock.json']) {
      copy(join(source, name), join(app, name))
    }
    copy(join(build, 'dist'), join(app, 'dist'))
    execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app, env: environment, stdio: 'inherit' })
    const media = join(app, 'dist', 'mediapipe', 'vision_wasm_internal.wasm')
    if (!existsSync(media) || !existsSync(join(app, 'dist', 'themes', 'index.json'))) throw new Error('Required gesture/theme assets missing from build')
    execFileSync('tar', ['-czf', join(result, 'app.tar.gz'), '-C', app, '.'], { stdio: 'inherit' })
    copy(join(source, 'deploy', 'windows'), join(result, 'installer'))
    cpSync(join(source, 'public', 'jarvis-relay.mjs'), join(result, 'jarvis-relay.mjs'))
    cpSync(join(source, 'deploy', 'windows', 'relay-launcher.mjs'), join(result, 'relay-launcher.mjs'))
    const files = {}
    // Hash every top-level artifact except installer source files.
    for (const name of readdirSync(result)) {
      if (name !== 'installer') files[name] = await sha256(join(result, name))
    }
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    writeFileSync(join(result, 'manifest.json'), JSON.stringify({ schema: 1, product: 'jarvis-refined',
      version: pkg.version, architecture: 'x64', createdAt: new Date().toISOString(),
      complete: true, files, prerequisites: windowsPrerequisites }, null, 2) + '\n')
    publishRelease(result, output)
    console.log(`Windows prerequisite-first installer payload: ${output}`)
    return output
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Report a concise build error and let Node exit naturally with a failure code.
  packageWindows().catch((error) => { console.error(error.message); process.exitCode = 1 })
}