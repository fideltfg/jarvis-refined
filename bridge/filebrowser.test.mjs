import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeTasksOf, deleteFile, fileHeaders, handleFilesRequest, listFiles, resolveFile } from './filebrowser.mjs'

const REPORT = 'goals/g_a/tasks/t_b/reports/latest.md'
const IMAGE = 'goals/g_a/tasks/t_b/artifacts/out.png'
const SESSION = 'sessions/11111111-1111-1111-1111-111111111111/reports/latest.md'

const PROJECT = 'projects/demo/reports/notes.md'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-files-'))
  const task = join(root, 'goals', 'g_a', 'tasks', 't_b')
  for (const folder of ['reports', 'artifacts', 'node_modules', '.git', '.hidden']) await mkdir(join(task, folder), { recursive: true })
  await mkdir(join(root, 'sessions', '11111111-1111-1111-1111-111111111111', 'reports'), { recursive: true })
  await writeFile(join(task, 'reports', 'latest.md'), '# hi')
  await writeFile(join(task, 'artifacts', 'out.png'), 'x')
  await writeFile(join(task, 'artifacts', '.dotfile'), 'x')
  await writeFile(join(task, 'node_modules', 'skip.js'), 'x')
  await writeFile(join(task, '.git', 'config'), 'x')
  await writeFile(join(task, '.hidden', 'note.md'), 'x')
  await writeFile(join(root, SESSION), 'session')
  await writeFile(join(root, 'secret.txt'), 'secret')
  await mkdir(join(root, 'projects', 'demo', 'reports'), { recursive: true })
  await writeFile(join(root, 'projects', 'demo', 'reports', 'notes.md'), 'p')
  return root
}

test('lists every work area except sessions, hidden entries and dependencies', async () => {
  const root = await fixture()
  try {
    const { files } = await listFiles({ root })
    assert.deepEqual(files.map((file) => file.path).sort(), [IMAGE, REPORT, PROJECT])
    assert.equal(files.find((file) => file.path === IMAGE).task, 't_b')
  } finally { await rm(root, { recursive: true }) }
})

test('refuses sessions, hidden paths, traversal, absolute paths and symlinks', async () => {
  const root = await fixture()
  try {
    const dir = join(root, 'goals', 'g_a', 'tasks', 't_b', 'reports')
    await symlink(join(root, 'secret.txt'), join(dir, 'link.txt'))
    await symlink(root, join(dir, 'linkdir'))
    for (const path of ['../secret.txt', '/etc/hosts', 'secret.txt', 'goals/g_a/tasks/../../../secret.txt', SESSION,
      'goals/g_a/tasks/t_b/.hidden/note.md', 'goals/g_a/tasks/t_b/.git/config', 'goals/g_a/tasks/t_b/artifacts/.dotfile',
      'goals/g_a/tasks/t_b/reports/link.txt', 'goals/g_a/tasks/t_b/reports/linkdir/secret.txt']) {
      await assert.rejects(resolveFile(path, { root }), /Invalid file path|File not found/, path)
    }
    await assert.doesNotReject(resolveFile(REPORT, { root }))
  } finally { await rm(root, { recursive: true }) }
})

test('delete needs writes enabled, known task state, and no running task', async () => {
  const root = await fixture()
  try {
    await assert.rejects(deleteFile(IMAGE, { root, activeTaskIds: new Set() }), /disabled/)
    await assert.rejects(deleteFile(IMAGE, { root, allowWrites: true }), /unavailable/)
    await assert.rejects(deleteFile(IMAGE, { root, allowWrites: true, activeTaskIds: new Set(['t_b']) }), /still running/)
    await assert.rejects(deleteFile(SESSION, { root, allowWrites: true, activeTaskIds: new Set() }), /Invalid file path/)
    assert.equal((await deleteFile(IMAGE, { root, allowWrites: true, activeTaskIds: new Set() })).deleted, true)
    await assert.rejects(readFile(join(root, IMAGE)))
  } finally { await rm(root, { recursive: true }) }
})

test('active tasks come from board status and running ids', () => {
  const active = activeTasksOf({ running: ['t_1'], goals: [{ tasks: [{ id: 't_2', status: 'queued' }, { id: 't_3', status: 'done' }] }] })
  assert.deepEqual([...active].sort(), ['t_1', 't_2'])
})

test('headers: downloads are opaque attachments, html previews as sandboxed text', () => {
  const download = fileHeaders('a/b/page.html', 5, true)
  assert.equal(download['content-type'], 'application/octet-stream')
  assert.match(download['content-disposition'], /^attachment/)
  const preview = fileHeaders('a/b/page.html', 5, false)
  assert.match(preview['content-type'], /^text\/plain/)
  assert.match(preview['content-security-policy'], /sandbox/)
  assert.equal(preview['x-content-type-options'], 'nosniff')
})

test('request handler lists and deletes, and replies with errors', async () => {
  const root = await fixture()
  try {
    const replies = []
    const send = (reply) => replies.push(reply)
    await handleFilesRequest({ type: 'files_request', requestId: 'r1', action: 'list' }, { api: null, allowWrites: true, send, root })
    assert.equal(replies[0].result.files.length, 3)
    assert.equal(replies[0].result.canDelete, true)
    await handleFilesRequest({ type: 'files_request', requestId: 'r2', action: 'delete', path: REPORT }, { api: null, allowWrites: true, send, root })
    assert.equal(replies[1].result.deleted, true)
    await handleFilesRequest({ type: 'files_request', requestId: 'r3', action: 'delete', path: IMAGE }, { api: { board: async () => { throw new Error('offline') } }, allowWrites: true, send, root })
    assert.match(replies[2].error, /offline/)
  } finally { await rm(root, { recursive: true }) }
})
