import { MEMORY_FILE, ops, today, update } from '../bridge/memory.mjs'

/**
 * The PA memory stays the user's own record: a goal JARVIS starts is added to
 * its Goals, and a finished one is logged. Tasks are not mirrored.
 */
export function paMirror(file = MEMORY_FILE) {
  const warn = (err) => console.warn('[agents] PA memory not updated:', err.message)
  return {
    goalCreated: (goal) =>
      update(file, (s) => ops.goal(s, { action: 'add', text: goal.title }, today())).catch(warn),
    goalDone: (goal, summary) =>
      update(file, (s) => ops.log(s, { text: `Goal done: ${goal.title} — ${summary}` }, today())).catch(warn),
  }
}
