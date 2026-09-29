/**
 * Theme packages, read from disk.
 *
 * The browser and the bridge have to agree on who the assistant is, and the
 * single source for that is `public/themes/<id>/` — the same folder a user
 * drops in. The browser names its theme on connect; this reads that folder's
 * persona so the two halves cannot drift apart.
 *
 * Nothing here trusts the id: it arrives over a WebSocket query string, so it
 * is matched against the folders that actually exist before it ever reaches a
 * path.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../public/themes', import.meta.url)))

/** Folder names only. Belt and braces with the directory check below. */
const isThemeId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(id)

export function themeIds() {
  if (!existsSync(ROOT)) return []
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, entry.name, 'theme.json')))
    .map((entry) => entry.name)
}

/**
 * The persona for a theme: persona.md if it has one, the manifest's `persona`
 * field otherwise, and an empty string if it has neither — the caller falls
 * back to the built-in default rather than running with no character at all.
 *
 * Read fresh on every call, which is once per connection, so editing a theme
 * and reloading the page is the whole edit-test loop.
 */
export function personaFor(id) {
  if (!isThemeId(id) || !themeIds().includes(id)) return ''
  const dir = join(ROOT, id)

  const prose = join(dir, 'persona.md')
  if (existsSync(prose)) {
    const text = readFileSync(prose, 'utf8').trim()
    if (text) return text
  }

  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8'))
    return typeof manifest.persona === 'string' ? manifest.persona.trim() : ''
  } catch (error) {
    console.warn(`[jarvis] theme "${id}" has an unreadable theme.json:`, error.message)
    return ''
  }
}

/** The id to actually run with, given whatever the browser asked for. */
export function resolveThemeId(requested, fallback = 'stark') {
  const installed = themeIds()
  if (isThemeId(requested) && installed.includes(requested)) return requested
  return installed.includes(fallback) ? fallback : (installed[0] ?? fallback)
}
