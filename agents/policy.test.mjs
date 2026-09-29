import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'

import { judge, recipientsOf } from './policy.mjs'

const WS = '/work/t1'
const ctx = (extra = {}) => ({ workspace: WS, kind: 'code', contacts: new Set(), exists: () => true, ...extra })
const bash = (command, extra) => judge('Bash', { command }, ctx(extra))
const decision = (v) => v.decision

test('ordinary development work is allowed', () => {
  for (const c of [
    'npm test',
    'git status && git add -A && git commit -m "fix"',
    'git push -u origin jarvis/fix-ci',
    'rm -rf node_modules dist/*',
    'mv a.txt b.txt',
    'find . -name "*.log" -delete',
    'git reset --hard HEAD~1',
  ]) assert.equal(decision(bash(c)), 'allow', c)
})

test('deleting or moving outside the workspace needs approval', () => {
  assert.equal(decision(bash('rm -rf /home/someone/photos')), 'approval')
  assert.equal(decision(bash('rm -rf ~/projects')), 'approval')
  assert.equal(decision(bash('mv report.md /etc/report.md')), 'approval')
  assert.equal(decision(bash('find /var/log -name "*.gz" -delete')), 'approval')
  assert.equal(bash('rm -rf /tmp/x').category, 'destruction')
})

test('a cd before a delete is judged from where the cd lands', () => {
  assert.equal(decision(bash('cd .. && rm -rf t2')), 'approval')
  assert.equal(decision(bash('cd src && rm -rf build')), 'allow')
})

test('a delete through an unresolved variable needs approval', () => {
  assert.equal(decision(bash('rm -rf "$TARGET"')), 'approval')
  assert.equal(decision(bash('rm -rf $(pwd)/x')), 'approval')
})

test('force pushes, remote branch deletes and history rewrites need approval', () => {
  for (const c of [
    'git push --force origin main',
    'git push -f',
    'git push --force-with-lease origin feature',
    'git push origin +main',
    'git push origin --delete old-branch',
    'git push origin :old-branch',
    'git filter-repo --path secrets',
    'git filter-branch --tree-filter x',
  ]) assert.equal(decision(bash(c)), 'approval', c)
})

test('dropping database objects needs approval', () => {
  assert.equal(decision(bash('psql -c "DROP TABLE users"')), 'approval')
  assert.equal(decision(bash('sqlite3 app.db "drop database x"')), 'approval')
})

test('credential files are denied outright, by tool or by shell', () => {
  assert.equal(decision(judge('Read', { file_path: '~/.ssh/id_rsa' }, ctx())), 'deny')
  assert.equal(decision(judge('Read', { file_path: `${homedir()}/.claude.json` }, ctx())), 'deny')
  assert.equal(decision(judge('Read', { file_path: `${WS}/.env` }, ctx())), 'deny')
  assert.equal(decision(judge('Read', { file_path: `${homedir()}/.config/jarvis/secrets.env` }, ctx())), 'deny')
  assert.equal(decision(bash('cat ~/.ssh/id_ed25519')), 'deny')
  assert.equal(decision(bash('cat $HOME/.ssh/config')), 'deny')
  assert.equal(bash('cat ~/.ssh/id_ed25519').category, 'credentials')
})

test('example env files are ordinary files', () => {
  assert.equal(decision(judge('Read', { file_path: `${WS}/.env.example` }, ctx())), 'allow')
})

test('secret-shaped values never leave in a tool call', () => {
  const key = 'sk-ant-api03-' + 'a'.repeat(40)
  assert.equal(decision(judge('WebFetch', { url: `https://x.test/?k=${key}` }, ctx())), 'deny')
  assert.equal(decision(judge('mcp__gmail__send_email', { to: 'a@b.c', body: '-----BEGIN OPENSSH PRIVATE KEY-----' }, ctx())), 'deny')
})

test('writing outside the workspace: approval for code, denied for research', () => {
  assert.equal(decision(judge('Write', { file_path: `${WS}/notes.md` }, ctx())), 'allow')
  assert.equal(decision(judge('Write', { file_path: '/home/x/.bashrc' }, ctx())), 'approval')
  assert.equal(decision(judge('Write', { file_path: '/tmp/new.txt' }, ctx({ exists: () => false }))), 'allow')
  assert.equal(decision(judge('Write', { file_path: '/tmp/new.txt' }, ctx({ kind: 'research', exists: () => false }))), 'deny')
})

test('money-moving tools need approval; reads do not', () => {
  assert.equal(decision(judge('mcp__stripe__create_refund', { charge: 'ch_1' }, ctx())), 'approval')
  assert.equal(decision(judge('mcp__stripe__list_customers', {}, ctx())), 'allow')
  assert.equal(decision(judge('mcp__shop__purchase_item', { sku: 'x' }, ctx())), 'approval')
  assert.equal(judge('mcp__shop__purchase_item', {}, ctx()).category, 'money')
})

test('acting on a payment page in Chrome needs approval; navigating does not', () => {
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_click', { target: 'Place your order' }, ctx())), 'approval')
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_navigate', { url: 'https://shop.test/checkout' }, ctx())), 'allow')
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_click', { target: 'Next page' }, ctx())), 'allow')
})

test('messages to someone new need approval; known contacts and drafts do not', () => {
  const known = ctx({ contacts: new Set(['ann@example.com']) })
  assert.equal(decision(judge('mcp__gmail__send_email', { to: 'Ann <ann@example.com>' }, known)), 'allow')
  const v = judge('mcp__gmail__send_email', { to: 'ann@example.com, bob@example.com' }, known)
  assert.equal(v.decision, 'approval')
  assert.equal(v.category, 'new_contact')
  assert.deepEqual(v.recipients, ['bob@example.com'])
  assert.equal(decision(judge('mcp__gmail__send_email', { body: 'hi' }, known)), 'approval')
  assert.equal(decision(judge('mcp__gmail__create_draft', { to: 'zed@example.com' }, known)), 'allow')
  assert.equal(decision(judge('mcp__db__postgres_query', { sql: 'select 1' }, known)), 'allow')
})

test('recipientsOf reads the usual fields and angle-bracket addresses', () => {
  assert.deepEqual(recipientsOf({ to: ['A <a@x.io>'], cc: 'b@x.io; c@x.io' }), ['a@x.io', 'b@x.io', 'c@x.io'])
})

test('the report tool is always allowed', () => {
  assert.equal(decision(judge('mcp__agent__report', { status: 'done', summary: 'ok' }, ctx())), 'allow')
})
