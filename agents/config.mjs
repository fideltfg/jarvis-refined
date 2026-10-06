import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Everything the agent service is tuned by, in one place. Paths and the port
 * can be overridden from the environment so tests and a second instance never
 * touch the real state.
 */
export const AGENTS_DIR =
  process.env.JARVIS_AGENTS_DIR || join(homedir(), '.config', 'jarvis', 'agents')
export const WORK_DIR = process.env.JARVIS_WORK_DIR || join(homedir(), '.jarvis-work')
export const PORT = Number(process.env.JARVIS_AGENTS_PORT) || 8788
export const TOKEN = process.env.JARVIS_AGENTS_TOKEN || ''
export const HOST = process.env.JARVIS_AGENTS_HOST || '127.0.0.1'

/**
 * The TLS material, read from disk at startup rather than held in the
 * environment: a private key is a file with an owner and a mode, and keeping it
 * one makes "who can read this" answerable. Returns null when no certificate is
 * configured, which is the ordinary loopback case; api.mjs is what decides that
 * null plus a non-loopback host is a refusal to start.
 *
 * A requestCert pair turns the door into mutual TLS — a client without a
 * certificate signed by JARVIS_AGENTS_TLS_CA is rejected at the handshake,
 * before the bearer token is ever read. The token alone is enough for a
 * loopback tunnel; for a service on the LAN it should not be.
 */
export function tlsOptions(env = process.env, readFile = readFileSync) {
  if (!env.JARVIS_AGENTS_TLS_CERT && !env.JARVIS_AGENTS_TLS_KEY) return null
  if (!env.JARVIS_AGENTS_TLS_CERT || !env.JARVIS_AGENTS_TLS_KEY) {
    throw new Error('JARVIS_AGENTS_TLS_CERT and JARVIS_AGENTS_TLS_KEY must be set together.')
  }
  const ca = env.JARVIS_AGENTS_TLS_CA
  return {
    cert: readFile(env.JARVIS_AGENTS_TLS_CERT),
    key: readFile(env.JARVIS_AGENTS_TLS_KEY),
    ...(ca ? { ca: readFile(ca), requestCert: true, rejectUnauthorized: true } : {}),
    minVersion: 'TLSv1.3',
  }
}

/**
 * The kinds of obstacle a blocked agent may name. The coordinator routes on
 * these, so the list is deliberately short and an agent that fits none of them
 * names none: unspecified is a real answer, a wrong code is not.
 */
export const BLOCKERS = ['approval', 'credential', 'decision', 'dependency', 'upstream']

export const MAX_WORKERS = 3
export const MAX_ATTEMPTS = 3
export const DEFAULT_TASK_CAP = 20

export const MODELS = {
  sonnet: process.env.JARVIS_AGENTS_SONNET || 'claude-sonnet-5',
  opus: process.env.JARVIS_AGENTS_OPUS || 'claude-opus-5',
}

export const BUDGETS = {
  code: { maxTurns: 60, maxMinutes: 45, maxUsd: 5 },
  research: { maxTurns: 30, maxMinutes: 20, maxUsd: 3 },
  marketing: { maxTurns: 30, maxMinutes: 20, maxUsd: 3 },
  ops: { maxTurns: 40, maxMinutes: 30, maxUsd: 3 },
  admin: { maxTurns: 30, maxMinutes: 20, maxUsd: 3 },
}

export const KINDS = Object.keys(BUDGETS)
