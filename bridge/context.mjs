import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readOptional(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

function installedSkills(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const file = join(root, entry.name, 'SKILL.md')
        const text = readOptional(file)
        return text ? `### ${entry.name}\n${text}` : ''
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/** User-authored context that must not depend on the selected model provider. */
export function sharedContext() {
  const home = homedir()
  const sections = []
  const preferences = readOptional(join(home, '.claude', 'CLAUDE.md'))
  if (preferences) sections.push(`User preferences and instructions:\n${preferences}`)

  const skills = installedSkills(join(home, '.claude', 'skills'))
  if (skills.length) sections.push(`Installed Jarvis skills:\n${skills.join('\n\n')}`)

  return sections.length
    ? `\n\nShared user context (available with every provider):\n${sections.join('\n\n')}`
    : ''
}