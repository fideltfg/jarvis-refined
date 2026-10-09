import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { packageWindows, publishRelease, releaseEnvironment, releaseFilter,
  windowsPrerequisites } from './package-windows.mjs'

// Locks the supported Windows release prerequisites to their documented values.
test('Windows release declares WSL, a dedicated Ubuntu distro and Node as prerequisites', () => {
  assert.deepEqual(windowsPrerequisites, [
    { id: 'wsl', minimumVersion: 2 },
    { id: 'linuxDistribution', name: 'Ubuntu-24.04', dedicated: true },
    { id: 'windowsNode', minimumMajor: 22 },
    { id: 'linuxNode', minimumMajor: 22 },
  ])
})

// Exercises cross-filesystem publication and verifies existing releases are preserved.
test('release publication works across filesystems without overwriting existing output', (context) => {
  const source = mkdtempSync(join(tmpdir(), 'jarvis-publish-'))
  const parent = mkdtempSync(join(resolve('node_modules'), 'jarvis-publish-'))
  // Remove temporary source and destination trees after the test completes.
  context.after(() => {
    rmSync(source, { recursive: true, force: true })
    rmSync(parent, { recursive: true, force: true })
  })
  writeFileSync(join(source, 'manifest.json'), 'release')
  const output = join(parent, 'payload')
  publishRelease(source, output)
  assert.equal(readFileSync(join(output, 'manifest.json'), 'utf8'), 'release')
  assert.throws(() => publishRelease(source, output), /already exists/)
  assert.equal(readFileSync(join(output, 'manifest.json'), 'utf8'), 'release')
})

// Ensures personal provider configuration cannot leak into a packaged build.
test('release build ignores developer provider and Vite environment settings', () => {
  assert.deepEqual(releaseEnvironment({ PATH: '/usr/bin', HOME: '/home/build',
    VITE_ANTHROPIC_API_KEY: 'private', JARVIS_ALLOW_WRITES: '1', OPENAI_API_KEY: 'private',
    ELEVENLABS_API_KEY: 'private', ANTHROPIC_API_KEY: 'private' }),
  { PATH: '/usr/bin', HOME: '/home/build' })
})

// Checks the package allowlist rejects credentials and test-only inputs.
test('release source copying excludes environment files, private keys and tests', () => {
  for (const name of ['.env', '.env.local', 'bridge/a.test.mjs', 'deploy/private.pem',
    'deploy/cert.pfx', '.git', 'secrets.json']) assert.equal(releaseFilter(name), false, name)
  for (const name of ['bridge/server.mjs', 'scripts/install.sh', 'public/model.wasm']) {
    assert.equal(releaseFilter(name), true, name)
  }
})

// Keeps unsupported packaging options from silently changing build behavior.
test('Windows package accepts only the application payload output option', async () => {
  await assert.rejects(packageWindows(['--rootfs', 'ubuntu.tar']), /Unknown option: --rootfs/)
  await assert.rejects(packageWindows(['--linux-node', 'node.tar.xz']), /Unknown option: --linux-node/)
  await assert.rejects(packageWindows(['--windows-node', 'node.zip']), /Unknown option: --windows-node/)
})