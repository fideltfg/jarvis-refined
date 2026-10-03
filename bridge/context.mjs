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

/** The frontmatter description, unquoted; the body stays on disk until needed. */
export function skillDescription(text) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const line = front?.[1].match(/^description:\s*(.*)$/m)?.[1].trim() ?? ''
  return line.replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/''/g, "'")
}

/**
 * An index, not the skills themselves: inlining every SKILL.md put kilobytes
 * on every turn of every conversation whether or not a skill was relevant.
 */
function installedSkills(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const file = join(root, entry.name, 'SKILL.md')
        const text = readOptional(file)
        if (!text) return ''
        const description = skillDescription(text)
        return `- ${entry.name}: ${description ? `${description} ` : ''}(${file})`
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
  if (skills.length) sections.push(`Installed Jarvis skills (read a skill's file before relying on it):\n${skills.join('\n')}`)

  return sections.length
    ? `\n\nShared user context (available with every provider):\n${sections.join('\n\n')}`
    : ''
}