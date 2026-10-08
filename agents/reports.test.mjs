import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTaskReference, taskReferences, taskReports } from './reports.mjs'

test('task reports list nested text reports, recall results, and reject escapes and oversized previews', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-reports-'))
  try {
    const workspace = join(root, 'task')
    await mkdir(join(workspace, 'reports', 'research'), { recursive: true })
    await mkdir(join(workspace, 'artifacts', 'research'), { recursive: true })
    await writeFile(join(workspace, 'reports', 'latest.md'), '# Completed')
    await writeFile(join(workspace, 'reports', 'research', 'findings.txt'), 'Findings')
    await writeFile(join(workspace, 'artifacts', 'research', 'chart.csv'), 'month,value\nJan,3')
    await writeFile(join(root, 'secret.md'), 'Private')
    await symlink(join(root, 'secret.md'), join(workspace, 'reports', 'escape.md'))
    const task = { workspace: { path: workspace }, result: { summary: 'Completed', artifacts: ['research/findings.txt'] } }
    assert.deepEqual(await taskReports(task), { result: task.result, failure: null, files: ['reports/latest.md', 'artifacts/research/chart.csv', 'reports/research/findings.txt'] })
    assert.deepEqual(await taskReports(task, 'research/findings.txt'), { file: 'research/findings.txt', content: 'Findings' })
    assert.deepEqual(await taskReports(task, 'artifacts/research/chart.csv'), { file: 'artifacts/research/chart.csv', content: 'month,value\nJan,3' })
    await assert.rejects(taskReports(task, '../../secret.md'), /Invalid/)
    await assert.rejects(taskReports(task, 'reports/escape.md'), /outside/)
    await assert.rejects(taskReports(task, 'artifacts/../../secret.md'), /Invalid/)
    await assert.rejects(taskReports(task, '/etc/passwd'), /Invalid/)
    await writeFile(join(workspace, 'reports', 'large.txt'), 'x'.repeat(512_001))
    await assert.rejects(taskReports(task, 'reports/large.txt'), /limit/)
    assert.deepEqual(await taskReports({ result: task.result }), { result: task.result, failure: null, files: [] })
    assert.deepEqual((await taskReports({ workspace: { path: join(root, 'missing') } })).files, [])
    await rm(join(workspace, 'reports'), { recursive: true })
    await symlink(root, join(workspace, 'reports'))
    await assert.rejects(taskReports(task), /outside/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('agent document references stay inside approved roots and have a bounded preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-reference-'))
  try {
    const workspace = join(root, 'task')
    await mkdir(join(workspace, 'artifacts'), { recursive: true })
    await writeFile(join(workspace, 'artifacts', 'notes.md'), '# Findings')
    await writeFile(join(root, 'outside.md'), 'Private')
    await symlink(join(root, 'outside.md'), join(workspace, 'artifacts', 'escape.md'))
    const task = { workspace: { path: workspace }, result: { references: [
      { title: 'Findings', path: 'artifacts/notes.md' },
      { title: 'Duplicate', path: 'artifacts/notes.md' },
      { title: 'Escape', path: 'artifacts/escape.md' },
      { title: 'Unsupported', path: 'artifacts/data.xlsx' },
    ] } }
    assert.equal(taskReferences(task).length, 3)
    assert.deepEqual(await readTaskReference(task, 0, { roots: [] }), { file: 'Findings', content: '# Findings' })
    await assert.rejects(readTaskReference(task, 1, { roots: [] }), /outside/)
    await assert.rejects(readTaskReference(task, 2, { roots: [] }), /Unsupported/)
    await assert.rejects(readTaskReference(task, 4, { roots: [] }), /unavailable/)
  } finally { await rm(root, { recursive: true, force: true }) }
})