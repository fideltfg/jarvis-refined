import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * The permission gate for autonomous workers.
 *
 * Everything is allowed except a short list of hard stops the user chose:
 * spending money, destroying data outside the task's own workspace (or on a
 * shared remote), touching credentials, and messaging someone new. Credentials
 * are denied outright; the rest become approval requests.
 *
 * This reads tool calls, so it is a strong seatbelt rather than a sandbox: a
 * script written to a file and then run can do things no pattern here sees.
 * The mitigations live elsewhere — Bash is confined to the worktree by cwd,
 * admin tasks get no Bash, every call is logged.
 */

const HOME = homedir()
const HOME_VAR = /\$HOME\b|\$\{HOME\}/g

const SECRET_PATH =
  /(^|\/)\.ssh(\/|$)|(^|\/)\.gnupg(\/|$)|(^|\/)secrets\.env$|(^|\/)\.env(?!\.(example|sample|template|dist)$)(\.[\w.-]+)?$|(^|\/)\.claude\.json$|(^|\/)\.password-store(\/|$)|keychain/i

const SECRET_VALUE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-ant-[\w-]{16,}|\bsk-[A-Za-z0-9]{32,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_\w{30,}|\bxox[abprs]-[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[\w.~+/-]{24,}/

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SEARCH_TOOLS = new Set(['Glob', 'Grep'])
const PREFIXES = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec'])
const DELETERS = new Set(['rm', 'rmdir', 'mv', 'shred', 'unlink', 'truncate'])

const MONEY_NAME = /(pay|payment|checkout|purchase|buy|charge|invoice|refund|subscri|transfer|payout)/i
const READ_VERB = /^(get|list|read|search|find|query|fetch|retrieve|describe|show|view|check)/i
const CHROME_ACT = /(click|type|fill|form|press|submit|select|key)/i
const CHECKOUT_TEXT = /(checkout|place (your )?order|pay now|purchase|card number|cvv|cvc|billing|confirm payment)/i
const SEND_NAME = /(send|reply|forward)|(^|[_-])post([_-]|$)/i
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

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out))
  return out
}

const segments = (command) =>
  String(command).split(/;|&&|\|\||\||\n/).map((s) => s.trim()).filter(Boolean)

const words = (segment) =>
  (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(['"])(.*)\1$/, '$2'))

const unresolved = (arg) => /[$`]/.test(arg.replace(HOME_VAR, ''))

function bashDestruction(command, workspace) {
  let cwd = workspace
  for (const seg of segments(command)) {
    let w = words(seg)
    while (w.length && (/^\w+=/.test(w[0]) || PREFIXES.has(w[0]))) w = w.slice(1)
    const [cmd, ...args] = w
    if (!cmd) continue
    const flat = ` ${args.join(' ')} `

    if (cmd === 'cd') {
      const to = args[0] ?? HOME
      cwd = unresolved(to) ? '/' : resolve(cwd, expandHome(to))
      continue
    }
    if (cmd === 'git') {
      if (args.includes('push')) {
        if (/\s(--force-with-lease|--force)(=\S+)?\s|\s-f\s|\s\+\S/.test(flat)) {
          return approval('destruction', 'git force-push', seg)
        }
        if (/\s(--delete|-d)\s|\s:\S/.test(flat)) return approval('destruction', 'delete a remote branch', seg)
      }
      if (args.includes('filter-repo') || args.includes('filter-branch')) {
        return approval('destruction', 'rewrite git history', seg)
      }
      continue
    }
    if (/\bdrop\s+(database|table|schema)\b/i.test(seg)) return approval('destruction', 'drop a database object', seg)

    const targets =
      cmd === 'find'
        ? /\s-delete\s|\s-exec\s+(rm|shred|unlink)\s/.test(flat)
          ? [args.find((a) => !a.startsWith('-')) ?? '.']
          : []
        : DELETERS.has(cmd)
          ? args.filter((a) => !a.startsWith('-'))
          : []
    for (const t of targets) {
      if (unresolved(t)) return approval('destruction', `${cmd} with an unresolved path`, seg)
      if (!inside(workspace, resolve(cwd, expandHome(t)))) {
        return approval('destruction', `${cmd} outside the workspace`, seg)
      }
    }
  }
  return null
}

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

export function judge(toolName, input = {}, ctx) {
  const { workspace, kind = 'code', contacts = new Set(), exists = existsSync } = ctx
  const name = String(toolName)

  if (strings(input).some((s) => SECRET_VALUE.test(s))) {
    return deny('credentials', 'The tool input contains something that looks like a secret key or token. Agents may never send or write secrets.')
  }

  if (FILE_TOOLS.has(name) || SEARCH_TOOLS.has(name)) {
    const target = input.file_path ?? input.notebook_path ?? input.path ?? '.'
    const abs = resolve(workspace, expandHome(target))
    if (SECRET_PATH.test(abs)) return deny('credentials', 'That path holds credentials. Agents may not read or change it.')
    if (WRITE_TOOLS.has(name) && !inside(workspace, abs)) {
      if (kind === 'research' || kind === 'admin') {
        return deny('workspace', `A ${kind} task may only write inside its own folder, ${workspace}.`)
      }
      if (exists(abs)) return approval('destruction', `overwrite ${abs}`, `${name} on a file outside the workspace`)
    }
    return allow()
  }

  if (name === 'Bash') {
    const command = String(input.command ?? '')
    for (const w of words(command.replace(/[;&|]/g, ' '))) {
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
      if (CHROME_ACT.test(tool) && strings(input).some((s) => CHECKOUT_TEXT.test(s))) {
        return approval('money', 'act on a payment page', `${tool}: ${brief(input)}`)
      }
      return allow()
    }
    if ((MONEY_NAME.test(tool) || server === 'stripe') && !READ_VERB.test(tool)) {
      return approval('money', `${server} ${tool}`, brief(input))
    }
    if (SEND_NAME.test(tool) && !/draft/i.test(tool)) {
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
