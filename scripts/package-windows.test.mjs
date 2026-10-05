import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { publishRelease, releaseEnvironment, releaseFilter, sha256, verifyArtifact } from './package-windows.mjs'

test('release publication works across filesystems without overwriting existing output', (context) => {
  const source = mkdtempSync(join(tmpdir(), 'jarvis-publish-'))
  const parent = mkdtempSync(join(resolve('node_modules'), 'jarvis-publish-'))
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

test('release build ignores developer provider and Vite environment settings', () => {
  assert.deepEqual(releaseEnvironment({ PATH: '/usr/bin', HOME: '/home/build',
    VITE_ANTHROPIC_API_KEY: 'private', JARVIS_ALLOW_WRITES: '1', OPENAI_API_KEY: 'private',
    ELEVENLABS_API_KEY: 'private', ANTHROPIC_API_KEY: 'private' }),
  { PATH: '/usr/bin', HOME: '/home/build' })
})

test('release source copying excludes environment files, private keys and tests', () => {
  for (const name of ['.env', '.env.local', 'bridge/a.test.mjs', 'deploy/private.pem',
    'deploy/cert.pfx', '.git', 'secrets.json']) assert.equal(releaseFilter(name), false, name)
  for (const name of ['bridge/server.mjs', 'scripts/install.sh', 'public/model.wasm']) {
    assert.equal(releaseFilter(name), true, name)
  }
})

test('prerequisite archives require explicit matching SHA-256 values', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-artifact-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'rootfs.tar')
  writeFileSync(file, 'known bytes')
  const hash = await sha256(file)
  assert.equal(await verifyArtifact(file, hash.toUpperCase()), hash)
  await assert.rejects(verifyArtifact(file, '0'.repeat(64)), /Checksum mismatch/)
  await assert.rejects(verifyArtifact(file, undefined), /explicit SHA-256/)
})