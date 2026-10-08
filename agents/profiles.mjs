import { z } from 'zod'
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

export const profileInput = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(10000),
  schedule: profileSchedule.nullable().optional(),
}).strict()

export const profileChanges = profileInput.partial().strict().refine((value) => Object.keys(value).length > 0, 'Provide at least one profile field to update.')

export function profileOutcome(profile) {
  return `Role: ${profile.role}\n\nInstructions:\n${profile.instructions}`
}