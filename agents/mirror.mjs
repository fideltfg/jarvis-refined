import { MEMORY_FILE, ops, today, update } from '../bridge/memory.mjs'

/**
 * The PA memory stays the user's own record: a goal JARVIS starts is added to
 * its Goals, and a finished one is logged. Tasks are not mirrored.
 */
export function paMirror(file = MEMORY_FILE) {
  /** Log mirror failures without rolling back the agent goal transition. */
  const warn = (err) => console.warn('[agents] PA memory not updated:', err.message)
  return {
    /** Add a newly created agent goal to the user's PA memory. */
    goalCreated: (goal) =>
      // Keep agent state authoritative if the separate memory file is unavailable.
      update(file, (s) => ops.goal(s, { action: 'add', text: goal.title }, today())).catch(warn),
    /** Append completed goal results to the user's PA activity log. */
    goalDone: (goal, summary) =>
      // Mirror only a concise result; worker tasks remain in the agent store.
      update(file, (s) => ops.log(s, { text: `Goal done: ${goal.title} — ${summary}` }, today())).catch(warn),
  }
}
