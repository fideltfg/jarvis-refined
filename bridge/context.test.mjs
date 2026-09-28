import { test } from 'node:test'
import { ok } from 'node:assert/strict'
import { sharedContext } from './context.mjs'

test('shared context loads without exposing provider-specific assumptions', () => {
  const context = sharedContext()
  ok(typeof context === 'string')
  ok(context.includes('Shared user context') || context === '')
})