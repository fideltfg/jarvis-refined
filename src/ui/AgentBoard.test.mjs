import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./AgentBoard.tsx', import.meta.url), 'utf8')

const deleteAgentBody = source.match(/async function deleteAgent\(row: BoardAgent\) \{[\s\S]*?\n  \}/)?.[0]

test('deleteAgent refuses a blocked (non-idle) row before ever asking to confirm', () => {
  assert.ok(deleteAgentBody, 'deleteAgent function body must exist')
  // The service-matching guard (deleteBlockReason) is checked first, and
  // returns early without ever reaching window.confirm or the network call.
  const guardThenConfirm = deleteAgentBody.indexOf('deleteBlockReason(row)') < deleteAgentBody.indexOf('window.confirm(')
  assert.ok(guardThenConfirm, 'deleteBlockReason must be checked before window.confirm')
  assert.match(deleteAgentBody, /const blocked = deleteBlockReason\(row\)\s*\n\s*if \(blocked\) \{ setError\(blocked\); return \}/)
})

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

test('the confirmation prompt names the agent and warns the removal of its history is permanent and irreversible', () => {
  assert.ok(deleteAgentBody)
  assert.match(deleteAgentBody, /window\.confirm\(`Delete “\$\{row\.name\}” permanently\?\\n\\nThis removes the agent and its task history, results and saved reports\. It cannot be undone\.`\)/)
})

test('a confirmed delete calls erase (never pause/resume/abandon) for the clicked row, not just the selection', () => {
  assert.ok(deleteAgentBody)
  assert.match(deleteAgentBody, /await goalControlRequest\(\{ goalId: row\.id, action: 'erase' \}\)/)
  assert.doesNotMatch(deleteAgentBody, /action: 'abandon'/)
})

test('the delete button in the UI is disabled whenever the row is blocked, so an active/busy/running agent cannot even be clicked', () => {
  const detailHead = source.match(/\{selected\.kind === 'goal' && view === 'agents' && <div className="ab-actions">[\s\S]*?<\/div>\}/)?.[0]
  assert.ok(detailHead, 'goal detail actions block must exist')
  assert.match(detailHead, /<button type="button" title=\{deleteBlock \?\?[\s\S]*?disabled=\{!online \|\| profileBusy \|\| deleteBlock !== null\}[\s\S]*?onClick=\{\(\) => void deleteAgent\(selected\)\}>/)
  assert.match(detailHead, /<Trash2 size=\{15\} aria-hidden="true" \/>Delete<\/button>/)
  // deleteBlock is computed from the shared, store-tested predicate, so the
  // button's disabled condition can never disagree with the service's guard.
  assert.match(source, /const deleteBlock = deleteBlockReason\(selected\)/)
})

test('deleteAgent imports the same deleteBlockReason/stateGroup predicates the board module exports and tests', () => {
  assert.match(source, /import \{[\s\S]*?deleteBlockReason[\s\S]*?\} from '\.\.\/lib\/board'/)
})
