import { z } from 'zod'
import { MAX_PROFILE_SKILLS, SKILL_ID, normalizeSkills } from '../bridge/skills.mjs'
import { triggerSchema } from './schedules.mjs'

const execution = z.object({
  provider: z.enum(['claude', 'openai', 'local']),
  model: z.string().trim().min(1).max(200),
}).strict()

const profileSchedule = z.object({
  trigger: triggerSchema,
  priority: z.number().int().min(1).max(5).default(3),
  execution: execution.optional(),
}).strict()

/**
 * Skills are named, never pathed: the id is the skill's directory name, which
 * is what the Skill tool itself takes. A path would rot the moment the user
 * moved their ~/.claude, and would carry a home directory into saved state.
 */
export const profileSkills = z.array(
  z.string().trim().min(1).max(100).regex(SKILL_ID, 'A skill name may use letters, digits, dots, dashes and underscores.'),
).max(MAX_PROFILE_SKILLS)

export const profileInput = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(10000),
  skills: profileSkills.optional(),
  schedule: profileSchedule.nullable().optional(),
}).strict()

export const profileChanges = profileInput.partial().strict().refine((value) => Object.keys(value).length > 0, 'Provide at least one profile field to update.')

export function profileOutcome(profile) {
  return `Role: ${profile.role}\n\nInstructions:\n${profile.instructions}`
}

/**
 * What a goal keeps of the profile it came from, frozen at the moment the run
 * started. Editing a profile must not change a run already under way, so the
 * selected skills are recorded here alongside the instructions rather than
 * read back off the profile when a worker starts.
 *
 * Takes either a stored profile or an earlier snapshot of one, since a pending
 * scheduled occurrence carries its own.
 */
export function profileSnapshot(profile) {
  return {
    id: profile.id,
    name: profile.name,
    role: profile.role,
    instructions: profile.instructions,
    skills: normalizeSkills(profile.skills),
    version: profile.updated,
  }
}