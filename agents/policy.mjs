import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/**
 * The permission gate for autonomous workers.
 *
 * Everything is allowed except a short list of hard stops the user chose:
 * spending money, destroying data outside the task's own workspace (or on a
 * shared remote or the shared git directory), touching credentials, and
 * messaging someone new. Credentials are denied outright; the rest become
 * approval requests.
 *
 * This reads tool calls, so it is a strong seatbelt rather than a sandbox: a
 * script written to a file and then run can do things no pattern here sees.
 * Where the shell parser meets something it does not model it errs towards
 * asking. The other mitigations live elsewhere — workers get a scrubbed
 * environment, Bash is confined to the worktree by cwd, admin tasks get no
 * Bash, and every call is logged.
 */

const HOME = homedir()
const HOME_VAR = /\$HOME\b|\$\{HOME\}/g

const SECRET_PATH = new RegExp(
  [
    String.raw`(^|/)\.ssh(/|$)`,
    String.raw`(^|/)\.gnupg(/|$)`,
    String.raw`(^|/)secrets\.env$`,
    String.raw`(^|/)\.env(?!\.(example|sample|template|dist)$)(\.[\w.-]+)?$`,
    String.raw`(^|/)\.envrc$`,
    String.raw`(^|/)\.claude\.json$`,
    String.raw`(^|/)\.claude/\.credentials\.json$`,
    String.raw`(^|/)\.git-credentials$`,
    String.raw`(^|/)\.netrc$`,
    String.raw`(^|/)\.npmrc$`,
    String.raw`(^|/)\.pgpass$`,
    String.raw`(^|/)\.pypirc$`,
    String.raw`(^|/)\.aws/credentials$`,
    String.raw`(^|/)\.config/gh/hosts\.yml$`,
    String.raw`(^|/)\.docker/config\.json$`,
    String.raw`(^|/)\.kube/config$`,
    String.raw`(^|/)\.password-store(/|$)`,
    String.raw`(^|/)\.config/jarvis(/|$)`,
    String.raw`^/proc/[^/]+/(environ|cmdline|mem)$`,
    'keychain',
  ].join('|'),
  'i',
)

/** Folders and files a recursive search must not be rooted above. */
const SECRET_LOCATIONS = [
  '.ssh', '.gnupg', '.config/jarvis', '.claude', '.claude.json', '.git-credentials', '.netrc', '.npmrc',
  '.pgpass', '.pypirc', '.aws', '.config/gh', '.docker', '.kube', '.password-store',
].map((p) => join(HOME, p)).concat('/proc')

const SECRET_VALUE_SOURCE =
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-ant-[\w-]{16,}|\bsk-[A-Za-z0-9]{32,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_\w{30,}|\bxox[abprs]-[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[\w.~+/-]{24,}`
const SECRET_VALUE = new RegExp(SECRET_VALUE_SOURCE)

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SEARCH_TOOLS = new Set(['Glob', 'Grep'])

const PREFIXES = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec', 'nice', 'builtin'])
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'case', 'esac'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const ALL_ARGS = new Set(['rm', 'rmdir', 'mv', 'shred', 'unlink', 'truncate', 'tee'])
const DEST_ARG = new Set(['cp', 'ln', 'install'])
const DELETERS = new Set(['rm', 'rmdir', 'shred', 'unlink', 'truncate', 'mv', 'rsync'])
const SAFE_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])

const MONEY_NAME = /(pay|payment|checkout|purchase|buy|charge|invoice|refund|subscri|transfer|payout)/i
const READ_VERB = /^(get|list|read|search|find|query|fetch|retrieve|describe|show|view|check(?!out))/i
const DESTROY_NAME = /(delete|remove|drop|destroy|purge|wipe|erase|truncate)/i
const SQL_DESTROY = /\b(drop|truncate)\s+(table|database|schema)\b|\bdelete\s+from\b/i
const CHROME_ACT = /^chrome_(click|type|key|form_input)$/
const CHECKOUT_TEXT = /(checkout|place (your )?order|pay now|purchase|card number|cvv|cvc|billing address|confirm payment|order summary)/i
const CHECKOUT_URL = /(checkout|\/cart\b|basket|payment|\/pay\b|billing|purchase|\/order|subscribe|donate)/i
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/
const SEND_NAME = /(send|reply|forward)|(^|[_-])post([_-]|$)/i
const DRAFT_EDIT = /^(create|update|save|edit)[_-]?draft/i
const RECIPIENT_KEYS = ['to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'emails', 'address', 'user', 'users', 'channel', 'phone', 'number', 'chat_id']

const allow = () => ({ decision: 'allow' })
const deny = (category, reason) => ({ decision: 'deny', category, reason })
const approval = (category, action, detail, extra = {}) => ({ decision: 'approval', category, action, detail, ...extra })

export const expandHome = (p) => String(p).replace(/^~(?=\/|$)/, HOME).replace(HOME_VAR, HOME)

/** True when `target` (absolute, or relative to root) is root or below it. */
export function inside(root, target) {
  const rel = relative(resolve(root), resolve(root, expandHome(target)))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export const looksLikeCheckoutUrl = (url) => CHECKOUT_URL.test(String(url))
export const looksLikeCheckoutPage = (text) => CHECKOUT_TEXT.test(String(text))

/** Secret-shaped values replaced, for the audit log. */
export const redact = (text) => String(text).replace(new RegExp(SECRET_VALUE_SOURCE, 'g'), '[redacted]')

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out))
  return out
}

const defaultRealpath = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// ------------------------------------------------------------------ shell

const unresolved = (arg) => /[$`]/.test(arg)
const clean = (word) => word.replace(/["'\\]/g, '')
const base = (cmd) => cmd.split('/').pop()
const flagless = (args) => args.filter((a) => !a.startsWith('-'))

/**
 * Command substitutions become their own segments and leave a `$SUB` behind,
 * so `rm -rf $(pwd)/x` still has an unresolvable target and `x=$(rm …)` still
 * shows the rm. Subshell parentheses and backgrounding become separators.
 */
function normalise(command) {
  let text = String(command).replace(HOME_VAR, HOME).replace(/\d*>&\d+/g, ' ').replace(/&>/g, '>')
  let prev
  do {
    prev = text
    text = text.replace(/\$\(([^()]*)\)/g, ' $SUB ; $1 ; ').replace(/`([^`]*)`/g, ' $SUB ; $1 ; ')
  } while (text !== prev)
  return text.replace(/(?<![\\$])[()]/g, ' ; ')
}

const segmentsOf = (text) =>
  text.split(/;|&&|\|\||\||&|\n/).map((s) => s.trim()).filter(Boolean)

const tokens = (segment) => (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(clean)

function redirections(segment) {
  const out = []
  for (const m of segment.matchAll(/(?:^|[^<>])>>?\s*([^\s;&|<>]+)/g)) out.push(clean(m[1]))
  return out
}

function gitVerdict(args, seg) {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[i]) ? 2 : 1
  const sub = args[i]
  const rest = args.slice(i + 1)
  const has = (...flags) => rest.some((a) => flags.includes(a))
  if (sub === 'push') {
    if (rest.some((a) => /^--force(-with-lease)?(=|$)/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || /^\+/.test(a))) {
      return approval('destruction', 'git force-push', seg)
    }
    if (has('--mirror', '--prune')) return approval('destruction', 'a git push that deletes remote refs', seg)
    if (has('--delete', '-d') || rest.some((a) => /^:\S/.test(a))) return approval('destruction', 'delete a remote branch', seg)
  }
  if (sub === 'branch' && rest.some((a) => ['-D', '-d', '--delete', '-M'].includes(a) || /^-[a-zA-Z]*[dD]$/.test(a))) {
    return approval('destruction', 'delete a git branch', seg)
  }
  if (sub === 'update-ref' && has('-d', '--delete')) return approval('destruction', 'delete a git ref', seg)
  if (sub === 'stash' && ['clear', 'drop'].includes(rest[0])) return approval('destruction', `git stash ${rest[0]}`, seg)
  if (sub === 'reflog' && ['expire', 'delete'].includes(rest[0])) return approval('destruction', 'expire the git reflog', seg)
  if (sub === 'gc' && rest.some((a) => a.startsWith('--prune'))) return approval('destruction', 'prune git objects', seg)
  if (sub === 'filter-repo' || sub === 'filter-branch') return approval('destruction', 'rewrite git history', seg)
  return null
}

function targetsOf(cmd, args) {
  if (ALL_ARGS.has(cmd)) return flagless(args)
  if (DEST_ARG.has(cmd)) return flagless(args).slice(-1)
  if (cmd === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return flagless(args).slice(1)
  if (cmd === 'dd') return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3))
  if (cmd === 'rsync' && args.some((a) => a.startsWith('--delete') || a === '--remove-source-files')) return flagless(args).slice(-1)
  if (cmd === 'find') {
    const exec = args.findIndex((a) => ['-exec', '-execdir', '-ok', '-okdir'].includes(a))
    if (args.includes('-delete') || (exec >= 0 && DELETERS.has(base(args[exec + 1] ?? '')))) {
      return [args.find((a) => !a.startsWith('-')) ?? '.']
    }
  }
  return []
}

function bashDestruction(command, workspace, startCwd = workspace, depth = 0) {
  if (depth > 3) return approval('destruction', 'a deeply nested shell command', command)
  let cwd = startCwd
  const check = (t, cmd, seg, allowHome = false) => {
    if (!t) return null
    if (SAFE_SINKS.has(t)) return null
    if (unresolved(t)) return approval('destruction', `${cmd} with an unresolved path`, seg)
    const target = resolve(cwd, expandHome(t))
    if (!inside(workspace, target) && !(allowHome && inside(HOME, target))) {
      return approval('destruction', `${cmd} outside the workspace`, seg)
    }
    return null
  }

  for (const seg of segmentsOf(normalise(command))) {
    if (/\bdrop\s+(database|table|schema)\b/i.test(seg)) return approval('destruction', 'drop a database object', seg)
    for (const t of redirections(seg)) {
      const v = check(t, 'redirect', seg, true)
      if (v) return v
    }
    let w = tokens(seg.replace(/\d*>>?\s*[^\s;&|<>]+/g, ' ').replace(/<\s*[^\s;&|<>]+/g, ' '))
    while (w.length && (/^\w+=/.test(w[0]) || PREFIXES.has(w[0]) || KEYWORDS.has(w[0]))) w = w.slice(1)
    if (!w.length) continue
    const cmd = base(w[0])
    const args = w.slice(1)

    if (cmd === 'cd' || cmd === 'pushd') {
      const to = args.find((a) => !a.startsWith('-') || a === '-')
      cwd = !to ? HOME : to === '-' || unresolved(to) ? '/' : resolve(cwd, expandHome(to))
      continue
    }
    if (cmd === 'popd') {
      cwd = '/'
      continue
    }
    if (SHELLS.has(cmd)) {
      const i = args.indexOf('-c')
      if (i >= 0) {
        const v = bashDestruction(args[i + 1] ?? '', workspace, cwd, depth + 1)
        if (v) return v
      }
      continue
    }
    if (cmd === 'eval') {
      const v = bashDestruction(args.join(' '), workspace, cwd, depth + 1)
      if (v) return v
      continue
    }
    if (cmd === 'xargs' && args.some((a) => DELETERS.has(base(a)))) {
      return approval('destruction', 'xargs into a delete', seg)
    }
    if (cmd === 'git') {
      const v = gitVerdict(args, seg)
      if (v) return v
      continue
    }
    for (const t of targetsOf(cmd, args)) {
      const v = check(t, cmd, seg, !DELETERS.has(cmd) && cmd !== 'find')
      if (v) return v
    }
  }
  return null
}

// -------------------------------------------------------------- messaging

export function recipientsOf(input) {
  const out = []
  for (const key of RECIPIENT_KEYS) {
    for (const s of strings(input?.[key])) {
      for (const part of s.split(/[,;]/)) {
        const m = part.match(/<([^>]+)>/)
        const r = (m ? m[1] : part).trim().toLowerCase()
        if (r) out.push(r)
      }
    }
  }
  return [...new Set(out)]
}

const brief = (input) => JSON.stringify(input).slice(0, 300)

// ------------------------------------------------------------------ judge

export function judge(toolName, input = {}, ctx) {
  const {
    workspace, kind = 'code', contacts = new Set(), exists = existsSync, realpath = defaultRealpath, commerce = false,
  } = ctx
  const name = String(toolName)

  if (strings(input).some((s) => SECRET_VALUE.test(s))) {
    return deny('credentials', 'The tool input contains something that looks like a secret key or token. Agents may never send or write secrets.')
  }

  if (FILE_TOOLS.has(name) || SEARCH_TOOLS.has(name)) {
    const target = input.file_path ?? input.notebook_path ?? input.path ?? '.'
    const abs = resolve(workspace, expandHome(target))
    const real = realpath(abs)
    if (SECRET_PATH.test(abs) || SECRET_PATH.test(real)) {
      return deny('credentials', 'That path holds credentials. Agents may not read or change it.')
    }
    if (SEARCH_TOOLS.has(name) && SECRET_LOCATIONS.some((loc) => inside(real, loc))) {
      return deny('credentials', 'That folder contains credentials. Search inside your working folder or a project folder instead.')
    }
    if (WRITE_TOOLS.has(name) && !inside(workspace, real)) {
      if (inside(realpath(HOME), real)) return allow()
      if (kind === 'research' || kind === 'marketing' || kind === 'admin') {
        return deny('workspace', `A ${kind} task may only write inside its own folder, ${workspace}.`)
      }
      if (exists(real)) return approval('destruction', `overwrite ${real}`, `${name} on a file outside the workspace`)
      return deny('workspace', `Generated files must stay inside the task folder, ${workspace}.`)
    }
    return allow()
  }

  if (name === 'Bash') {
    const command = String(input.command ?? '')
    for (const w of tokens(normalise(command).replace(/[;&|<>]/g, ' '))) {
      if (SECRET_PATH.test(expandHome(w))) {
        return deny('credentials', 'That command touches a credentials file. Agents may not read or change it.')
      }
    }
    return bashDestruction(command, workspace) ?? allow()
  }

  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__')
    const tool = rest.join('__')
    if (server === 'agent') return allow()

    if (server === 'jarvis_chrome') {
      if (CHROME_ACT.test(tool)) {
        if (commerce) return approval('money', 'act on a payment page', `${tool}: ${brief(input)}`)
        if (strings(input).some((s) => CHECKOUT_TEXT.test(s))) return approval('money', 'act on a payment page', `${tool}: ${brief(input)}`)
        if (tool === 'chrome_type' && CARD_NUMBER.test(String(input.text ?? ''))) {
          return approval('money', 'type what looks like a card number', `${tool}`)
        }
      }
      return allow()
    }

    if ((MONEY_NAME.test(tool) || server === 'stripe') && !READ_VERB.test(tool)) {
      return approval('money', `${server} ${tool}`, brief(input))
    }
    if (DESTROY_NAME.test(tool) || strings(input).some((s) => SQL_DESTROY.test(s))) {
      return approval('destruction', `${server} ${tool}`, brief(input))
    }
    if (SEND_NAME.test(tool) && !DRAFT_EDIT.test(tool)) {
      const recipients = recipientsOf(input)
      if (!recipients.length) return approval('new_contact', `${server} ${tool}`, 'Could not tell who this message goes to.')
      const unknown = recipients.filter((r) => !contacts.has(r))
      if (unknown.length) {
        return approval('new_contact', `message ${unknown.join(', ')}`, `${server} ${tool} to someone not contacted before`, { recipients: unknown })
      }
    }
    return allow()
  }

  return allow()
}
