import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { outputGuide, outputWriteError, sessionWorkspace, toolOutputError } from './workspace.mjs'

test('session output has stable structured folders and rejects escaping IDs', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-output-'))
  try {
    const id = '12345678-1234-1234-1234-123456789abc'
    const directory = sessionWorkspace(id, root)
    assert.equal(directory, join(root, 'sessions', id))
    assert.equal(sessionWorkspace(id, root), directory)
    for (const name of ['reports', 'artifacts', 'logs', 'tmp']) assert.ok(existsSync(join(directory, name)))
    assert.throws(() => sessionWorkspace('../../escape', root))
    assert.match(outputGuide(directory), /EVERY delegated agent/)
    assert.match(outputGuide(directory), /Editing actual project/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('bridge uses the structured workspace for Claude and every provider prompt', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(source, /sessionWorkspace\(checkpoint.id\)/)
  assert.match(source, /cwd: workingDirectory/)
  assert.match(source, /outputGuide\(workingDirectory\)/)
  assert.match(source, /const projectRoots = \[WORK_DIR, join\(homedir\(\), 'Projects'\)/)
  assert.match(source, /dir: saved.claudeWorkspace \?\? homedir\(\)/)
})

test('file outputs allow project edits but reject home files, traversal and symlink escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-output-gate-'))
  try {
    const directory = sessionWorkspace('12345678-1234-1234-1234-123456789abc', root)
    const project = join(root, 'project')
    mkdirSync(project)
    assert.equal(outputWriteError('reports/topic/final.md', directory), null)
    assert.match(outputWriteError(join(homedir(), 'Documents', 'notes.md'), directory, [join(homedir(), 'Projects')]), /must stay/)
    assert.match(outputWriteError(join(root, 'random-report.md'), directory), /must stay/)
    assert.match(outputWriteError('../escaped.md', directory), /must stay/)
    assert.equal(outputWriteError(join(project, 'source.mjs'), directory, [project]), null)
    assert.equal(toolOutputError('Read', { file_path: '/etc/hosts' }, directory), null)
    assert.match(toolOutputError('Write', { file_path: join(root, 'report.md') }, directory), /must stay/)
    symlinkSync(project, join(directory, 'artifacts', 'escape'))
    assert.match(outputWriteError('artifacts/escape/new/report.md', directory), /must stay/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})