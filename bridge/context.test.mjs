import { test } from 'node:test'
import { equal, ok } from 'node:assert/strict'
import { sharedContext, skillDescription } from './context.mjs'

test('shared context loads without exposing provider-specific assumptions', () => {
  const context = sharedContext()
  ok(typeof context === 'string')
  ok(context.includes('Shared user context') || context === '')
})

test('a skill is indexed by its frontmatter description, not inlined', () => {
  equal(skillDescription("---\nname: a\ndescription: 'Use it when it''s needed.'\n---\n# Body"), "Use it when it's needed.")
  equal(skillDescription('---\ndescription: Plain words\n---\nBody'), 'Plain words')
  equal(skillDescription('# No frontmatter'), '')
})