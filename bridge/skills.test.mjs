import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_PROFILE_SKILLS,
  installedSkillIndex,
  listInstalledSkills,
  normalizeSkills,
  skillDescription,
  skillName,
  skillsRoot,
  unknownSkills,
} from './skills.mjs'

/** A skills directory on disk, written the way the Claude CLI lays one out. */
function fresh(skills = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-skills-'))
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(join(root, name), { recursive: true })
    if (body !== null) writeFileSync(join(root, name, 'SKILL.md'), body)
  }
  return root
}

const manifest = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nThe body, which stays on disk.\n`

test('skills live under the user home, not the project', () => {
  assert.equal(skillsRoot('/home/someone'), join('/home/someone', '.claude', 'skills'))
})

test('a skill reports a stable id, a display name, a description and where it came from', () => {
  const root = fresh({ 'loose-ends': manifest('loose-ends', 'Close out unfinished work.') })
  const [skill] = listInstalledSkills(root)
  assert.equal(skill.id, 'loose-ends')
  assert.equal(skill.name, 'loose-ends')
  assert.equal(skill.description, 'Close out unfinished work.')
  assert.equal(skill.dir, join(root, 'loose-ends'))
  assert.equal(skill.file, join(root, 'loose-ends', 'SKILL.md'))
})

test('the id is the directory name even when the frontmatter name disagrees, because that is what the Skill tool takes', () => {
  const root = fresh({ 'a2-communication': manifest('A2 Communication', 'Talk to another agent.') })
  const [skill] = listInstalledSkills(root)
  assert.equal(skill.id, 'a2-communication')
  assert.equal(skill.name, 'A2 Communication')
})

test('a directory without a readable SKILL.md is not a skill, and listing is sorted by id', () => {
  const root = fresh({ zeta: manifest('zeta', 'Last.'), alpha: manifest('alpha', 'First.'), 'not-a-skill': null })
  assert.deepEqual(listInstalledSkills(root).map((skill) => skill.id), ['alpha', 'zeta'])
})

test('a missing skills root is not an error: skills are optional', () => {
  assert.deepEqual(listInstalledSkills(join(fresh(), 'nowhere')), [])
  assert.deepEqual(installedSkillIndex(join(fresh(), 'nowhere')), [])
  assert.deepEqual(unknownSkills(['anything'], { root: join(fresh(), 'nowhere') }), ['anything'])
})

test('the prompt index stays an index: name, description and path, never the body', () => {
  const root = fresh({ 'loose-ends': manifest('loose-ends', 'Close out unfinished work.') })
  const [line] = installedSkillIndex(root)
  assert.equal(line, `- loose-ends: Close out unfinished work. (${join(root, 'loose-ends', 'SKILL.md')})`)
  assert.doesNotMatch(line, /stays on disk/)
})

test('frontmatter values are unquoted, and absent frontmatter yields nothing rather than throwing', () => {
  assert.equal(skillDescription("---\nname: a\ndescription: 'Use it when it''s needed.'\n---\n# Body"), "Use it when it's needed.")
  assert.equal(skillDescription('---\ndescription: Plain words\n---\nBody'), 'Plain words')
  assert.equal(skillDescription('# No frontmatter'), '')
  assert.equal(skillName('---\nname: "Quoted Name"\n---\n'), 'Quoted Name')
  assert.equal(skillName('# No frontmatter'), '')
})

test('a selection is trimmed, de-duplicated, capped, and free of anything that cannot be a skill id', () => {
  assert.deepEqual(normalizeSkills([' loose-ends ', 'loose-ends', '', null, 'a2-communication']), ['loose-ends', 'a2-communication'])
  // A path is not an id. Keeping one would carry a home directory into saved state.
  assert.deepEqual(normalizeSkills(['/home/me/.claude/skills/loose-ends', '../escape', 'with space']), [])
  assert.deepEqual(normalizeSkills('loose-ends'), [])
  assert.deepEqual(normalizeSkills(undefined), [])
  assert.equal(normalizeSkills(Array.from({ length: MAX_PROFILE_SKILLS + 5 }, (_, i) => `skill-${i}`)).length, MAX_PROFILE_SKILLS)
})

test('names that are not installed are reported so a caller can choose to refuse or to keep them', () => {
  const root = fresh({ alpha: manifest('alpha', 'Here.') })
  assert.deepEqual(unknownSkills(['alpha'], { root }), [])
  assert.deepEqual(unknownSkills(['alpha', 'gone'], { root }), ['gone'])
  // An already-read listing can be passed in, so one readdir can serve a whole request.
  assert.deepEqual(unknownSkills(['gone'], { installed: [{ id: 'alpha' }] }), ['gone'])
})
