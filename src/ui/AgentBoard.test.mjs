import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./AgentBoard.tsx', import.meta.url), 'utf8')

const deleteAgentBody = source.match(/async function deleteAgent\(row: BoardAgent\) \{[\s\S]*?\n  \}/)?.[0]

// Ensure service-owned deletion guards run before presenting a confirmation prompt.
test('deleteAgent refuses a blocked (non-idle) row before ever asking to confirm', () => {
  assert.ok(deleteAgentBody, 'deleteAgent function body must exist')
  // The service-matching guard (deleteBlockReason) is checked first, and
  // returns early without ever reaching window.confirm or the network call.
  const guardThenConfirm = deleteAgentBody.indexOf('deleteBlockReason(row)') < deleteAgentBody.indexOf('window.confirm(')
  assert.ok(guardThenConfirm, 'deleteBlockReason must be checked before window.confirm')
  assert.match(deleteAgentBody, /const blocked = deleteBlockReason\(row\)\s*\n\s*if \(blocked\) \{ setError\(blocked\); return \}/)
})

// Verify cancellation returns before any request, selection, or roster side effect.
test('declining the confirm prompt leaves deleteAgent a no-op: no erase call, no selection change, no revision bump', () => {
  assert.ok(deleteAgentBody)
  // window.confirm must gate everything that follows it: a `return` right
  // after the confirm call, before any goalControlRequest/selection/revision
  // side effect, is what makes "Cancel" delete nothing.
  assert.match(deleteAgentBody, /if \(!window\.confirm\([\s\S]*?\)\) return/)
  const confirmIndex = deleteAgentBody.indexOf('if (!window.confirm(')
  const eraseIndex = deleteAgentBody.indexOf("action: 'erase'")
  const revisionIndex = deleteAgentBody.indexOf('setRevision(')
  const selectionIndex = deleteAgentBody.indexOf('setSelectedId(')
  assert.ok(confirmIndex >= 0 && eraseIndex > confirmIndex, 'the erase request must come after the confirm guard')
  assert.ok(revisionIndex > confirmIndex, 'the roster refresh must come after the confirm guard')
  assert.ok(selectionIndex > confirmIndex, 'the selection change must come after the confirm guard')
})

// Keep the destructive confirmation specific about the selected agent and removed history.
test('the confirmation prompt names the agent and warns the removal of its history is permanent and irreversible', () => {
  assert.ok(deleteAgentBody)
  assert.match(deleteAgentBody, /window\.confirm\(`Delete “\$\{row\.name\}” permanently\?\\n\\nThis removes the agent and its task history, results and saved reports\. It cannot be undone\.`\)/)
})

// Ensure confirmation erases the clicked row rather than applying a lifecycle transition.
test('a confirmed delete calls erase (never pause/resume/abandon) for the clicked row, not just the selection', () => {
  assert.ok(deleteAgentBody)
  assert.match(deleteAgentBody, /await goalControlRequest\(\{ goalId: row\.id, action: 'erase' \}\)/)
  assert.doesNotMatch(deleteAgentBody, /action: 'abandon'/)
})

// Keep the destructive button disabled whenever shared service policy forbids deletion.
test('the delete button in the UI is disabled whenever the row is blocked, so an active/busy/running agent cannot even be clicked', () => {
  const detailHead = source.match(/\{selected\.kind === 'goal' && view === 'agents' && <div className="ab-actions">[\s\S]*?<\/div>\}/)?.[0]
  assert.ok(detailHead, 'goal detail actions block must exist')
  assert.match(detailHead, /<button type="button" title=\{deleteBlock \?\?[\s\S]*?disabled=\{!online \|\| profileBusy \|\| deleteBlock !== null\}[\s\S]*?onClick=\{\(\) => void deleteAgent\(selected\)\}>/)
  assert.match(detailHead, /<Trash2 size=\{15\} aria-hidden="true" \/>Delete<\/button>/)
  // deleteBlock is computed from the shared, store-tested predicate, so the
  // button's disabled condition can never disagree with the service's guard.
  assert.match(source, /const deleteBlock = deleteBlockReason\(selected\)/)
})

const profileEditorBody = source.match(/function ProfileEditor\(\{ profile[\s\S]*?\n\}/)?.[0]

test('the editor opens with the profile’s saved skills already ticked, and with none for a new profile', () => {
  assert.ok(profileEditorBody, 'ProfileEditor function body must exist')
  // Initial state comes from the profile being edited, so an edit starts from
  // what was saved; a create (profile === null) starts from nothing selected.
  assert.match(profileEditorBody, /const \[skills, setSkills\] = useState<string\[\]>\(profile\?\.skills \?\? \[\]\)/)
})

test('the skill picker is a checkbox list that can select and deselect several skills, like the weekday picker', () => {
  assert.ok(profileEditorBody)
  const fieldset = profileEditorBody.match(/<fieldset className="ab-weekdays ab-skills">[\s\S]*?<\/fieldset>/)?.[0]
  assert.ok(fieldset, 'the skills fieldset must exist')
  assert.match(fieldset, /<legend>Skills<\/legend>/)
  assert.match(fieldset, /<input type="checkbox" checked=\{skills\.includes\(skill\.id\)\}[\s\S]*?onChange=\{\(event\) => toggleSkill\(skill\.id, event\.target\.checked\)\}/)
  // Ticking adds and unticking removes, so the control is a real multi-select.
  assert.match(profileEditorBody, /const toggleSkill = \(skillId: string, on: boolean\) =>/)
  assert.match(profileEditorBody, /on \? \[\.\.\.previous\.filter\(\(value\) => value !== skillId\), skillId\]\.sort\(\) : previous\.filter\(\(value\) => value !== skillId\)/)
})

test('the picker offers what is installed, fetched over the same profile channel rather than read from disk in the browser', () => {
  assert.ok(profileEditorBody)
  assert.match(profileEditorBody, /profileRequest\(\{ action: 'skills' \}\)/)
  // A failed lookup leaves an empty list and a visible message, not a blank
  // fieldset that silently claims nothing is installed.
  assert.match(profileEditorBody, /\.catch\(\(err: unknown\) => \{ if \(live\) \{ setInstalled\(\[\]\); setSkillsError\(/)
  assert.match(profileEditorBody, /\{skillsError && <p role="alert">\{skillsError\}<\/p>\}/)
})

test('a saved skill that is no longer installed stays listed, stays ticked and is marked missing', () => {
  assert.ok(profileEditorBody)
  const choices = profileEditorBody.match(/const choices = useMemo\(\(\) => \{[\s\S]*?\}, \[installed, skills\]\)/)?.[0]
  assert.ok(choices, 'the choices memo must exist')
  // Anything the profile already named but the machine no longer has is added
  // to the list rather than filtered out, so an unrelated edit cannot drop it.
  assert.match(choices, /skills\.filter\(\(skillId\) => !known\.has\(skillId\)\)/)
  assert.match(choices, /missing: true/)
  // Nothing is called missing before the installed list has arrived.
  assert.match(choices, /if \(installed === null\) return \[\]/)
  assert.match(profileEditorBody, /\{skill\.missing \? ' \(missing\)' : ''\}/)
})

test('saving sends the selection as part of the profile input, so it is persisted with the rest of the profile', () => {
  assert.ok(profileEditorBody)
  assert.match(profileEditorBody, /await onSave\(\{ name, role, instructions, skills, schedule \}\)/)
  // Ids only. A path would carry a home directory into saved state and would
  // rot the moment the user moved their ~/.claude.
  assert.doesNotMatch(profileEditorBody, /skill\.(dir|file)/)
})

// Ensure the component uses the shared tested predicates rather than duplicate policy.
test('deleteAgent imports the same deleteBlockReason/stateGroup predicates the board module exports and tests', () => {
  assert.match(source, /import \{[\s\S]*?deleteBlockReason[\s\S]*?\} from '\.\.\/lib\/board'/)
})
