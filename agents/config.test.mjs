import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tlsOptions } from './config.mjs'

/**
 * The certificate is read from disk, so these tests hand in a reader rather
 * than touching the filesystem: what matters is which paths are read and what
 * shape comes back, not what is in them.
 */
const reader = (seen) => (path) => {
  seen.push(path)
  return `--- ${path} ---`
}

test('no certificate configured is the ordinary loopback case, not an error', () => {
  assert.equal(tlsOptions({}, () => 'x'), null)
})

test('half a certificate is a refusal, both ways round', () => {
  assert.throws(() => tlsOptions({ JARVIS_AGENTS_TLS_CERT: '/c.pem' }, () => 'x'), /must be set together/)
  assert.throws(() => tlsOptions({ JARVIS_AGENTS_TLS_KEY: '/k.pem' }, () => 'x'), /must be set together/)
})

test('a cert and key are read from their paths, and the floor is TLS 1.3', () => {
  const seen = []
  const opts = tlsOptions({ JARVIS_AGENTS_TLS_CERT: '/c.pem', JARVIS_AGENTS_TLS_KEY: '/k.pem' }, reader(seen))
  assert.deepEqual(seen, ['/c.pem', '/k.pem'])
  assert.equal(opts.cert, '--- /c.pem ---')
  assert.equal(opts.key, '--- /k.pem ---')
  assert.equal(opts.minVersion, 'TLSv1.3')
  // No CA named means no client certificate demanded; the token is the gate.
  assert.equal(opts.requestCert, undefined)
  assert.equal(opts.rejectUnauthorized, undefined)
})

test('naming a CA turns it into mutual TLS, refused before the token is read', () => {
  const seen = []
  const opts = tlsOptions(
    { JARVIS_AGENTS_TLS_CERT: '/c.pem', JARVIS_AGENTS_TLS_KEY: '/k.pem', JARVIS_AGENTS_TLS_CA: '/ca.pem' },
    reader(seen),
  )
  assert.deepEqual(seen, ['/c.pem', '/k.pem', '/ca.pem'])
  assert.equal(opts.ca, '--- /ca.pem ---')
  assert.equal(opts.requestCert, true)
  assert.equal(opts.rejectUnauthorized, true)
})
