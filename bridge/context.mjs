import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installedSkillIndex, skillsRoot } from './skills.mjs'

function readOptional(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

/** Kept here for the callers that only want a SKILL.md's description. */
export { skillDescription } from './skills.mjs'

/** User-authored context that must not depend on the selected model provider. */
export function sharedContext() {
  const home = homedir()
  const sections = []
  const preferences = readOptional(join(home, '.claude', 'CLAUDE.md'))
  if (preferences) sections.push(`User preferences and instructions:\n${preferences}`)

  const skills = installedSkillIndex(skillsRoot(home))
  if (skills.length) sections.push(`Installed Jarvis skills (read a skill's file before relying on it):\n${skills.join('\n')}`)

  return sections.length
    ? `\n\nShared user context (available with every provider):\n${sections.join('\n\n')}`
    : ''
}