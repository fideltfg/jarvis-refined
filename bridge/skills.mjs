import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * One place that knows where skills live and what a SKILL.md says about
 * itself. Both the index inlined into a prompt (bridge/context.mjs) and the
 * picker on an agent profile read from here, so what a person can choose and
 * what a run can actually find cannot drift apart.
 */

/** How many skills one agent profile may name; the same cap the remote runtime uses. */
export const MAX_PROFILE_SKILLS = 16

/** A skill's stable id is its directory name, which is what the Skill tool takes. */
export const SKILL_ID = /^[a-z0-9][a-z0-9._-]*$/i

/** Skills are the user's, not the project's: one directory per skill under ~/.claude. */
export function skillsRoot(home = homedir()) {
  return join(home, '.claude', 'skills')
}

function readOptional(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

function frontmatter(text) {
  return text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
}

const unquote = (line) => line.replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/''/g, "'")

/** The frontmatter description, unquoted; the body stays on disk until needed. */
export function skillDescription(text) {
  return unquote(frontmatter(text).match(/^description:\s*(.*)$/m)?.[1].trim() ?? '')
}

/** The frontmatter name, which should match the directory but is not guaranteed to. */
export function skillName(text) {
  return unquote(frontmatter(text).match(/^name:\s*(.*)$/m)?.[1].trim() ?? '')
}

/**
 * Every readable skill on disk: stable id (the directory name), display name,
 * description and source directory. A directory without a readable SKILL.md is
 * not a skill, and a missing root is not an error — skills are optional.
 */
export function listInstalledSkills(root = skillsRoot()) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && SKILL_ID.test(entry.name))
    .map((entry) => {
      const dir = join(root, entry.name)
      const file = join(dir, 'SKILL.md')
      const text = readOptional(file)
      if (!text) return null
      return {
        id: entry.name,
        name: skillName(text) || entry.name,
        description: skillDescription(text),
        dir,
        file,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * An index, not the skills themselves: inlining every SKILL.md put kilobytes
 * on every turn of every conversation whether or not a skill was relevant.
 */
export function installedSkillIndex(root = skillsRoot()) {
  return listInstalledSkills(root)
    .map((skill) => `- ${skill.id}: ${skill.description ? `${skill.description} ` : ''}(${skill.file})`)
}

/** Trim, drop blanks, drop anything that cannot be a skill id, and keep first mention. */
export function normalizeSkills(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const entry of value) {
    const id = String(entry ?? '').trim()
    if (id && SKILL_ID.test(id)) seen.add(id)
  }
  return [...seen].slice(0, MAX_PROFILE_SKILLS)
}

/**
 * Which of these ids are not installed right now. Skills come and go on disk
 * independently of the profiles that name them, so callers decide whether a
 * name they cannot see is a mistake to reject or an old choice to keep.
 */
export function unknownSkills(ids, { root = skillsRoot(), installed } = {}) {
  const known = new Set((installed ?? listInstalledSkills(root)).map((skill) => skill.id))
  return normalizeSkills(ids).filter((id) => !known.has(id))
}
