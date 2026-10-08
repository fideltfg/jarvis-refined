/**
 * Theme packages.
 *
 * A theme is a folder under `public/themes/<id>/` — a `theme.json` manifest, an
 * optional `theme.css`, `theme.tsx`, and an `audio/` directory of cue recordings.
 * Drop one in, restart, and it is selectable; nothing in `src/` has to change.
 * That is the whole point: the character the interface plays is content, not
 * code, so a new one costs a folder rather than a pull request.
 *
 * The manifest is merged over DEFAULTS, so a two-field theme.json is a valid
 * theme. Components and synthesised sounds are exported by its own theme.tsx
 * module. Missing exports use shared defaults; there is no character registry.
 *
 * Everything here resolves BEFORE React mounts (see main.tsx), which is what
 * lets the rest of the codebase keep reading theme values as plain module-level
 * constants instead of threading a context through every component.
 */

import type { Phase } from '../store'
import type { ThemePackage } from './theme-package'

const packages = import.meta.glob<{ default: ThemePackage }>('../../public/themes/*/theme.tsx')
let implementation: ThemePackage = {}

export const activeThemePackage = (): ThemePackage => implementation

export type ThemeCopy = {
  title: string
  brand: string
  brandSub: string
  speaker: string
  wakePhrase: string
  status: Record<Phase, string>
  systemsTitle: string
  signalTitle: string
  toolKicker: string
  ignitionWord: string
  ignitionSub: string
  voiceSetTail: string
  audioTest: string
}

export type VoiceProfileShape = {
  label: string
  speed: number
  playbackRate: number
  highpassHz: number
  lowpassHz: number
  presenceHz: number
  presenceDb: number
  compression: { threshold: number; ratio: number; attack: number; release: number }
}

export type ThemeManifest = {
  /** Folder name. Authoritative — a mismatched `id` inside the file is ignored. */
  id: string
  name: string
  copy: ThemeCopy
  /** Browser chrome colour, and the meta[name=theme-color] value. */
  backgroundColor: string
  phaseColors: Record<Phase, string>
  sceneTint: { core: string; hot: string; particles: string }
  wake: { pattern: string; phrases: string[]; language: string }
  voice: {
    engine: 'kokoro' | 'system' | null
    /** Kokoro voice id. Unknown ids fall back to the default in config.ts. */
    kokoro: string
    /** Which system-voice ranking to use when Kokoro is off. */
    character: 'british-male' | 'computer'
    profile: VoiceProfileShape
  }
  sound: {
    /**
     * Whether the theme has a score — the boot swell and the loop under a
     * running tool. Off means the synthesised room tone is the only bed, which
     * is what a mainframe or a ship's bridge actually sounds like.
     */
    music: boolean
    ambient: { tones: [number, number]; noise: number; cutoff: number; level: number }
  }
  bootDurationMs: number
  /**
   * Which phrasebook the filler and agent announcements use. A butler says
   * "Very good, sir"; a machine says "Acknowledged."
   */
  register: 'butler' | 'machine'
  /** One example command in the character's own idiom, for the idle hint. */
  suggestion: string
  /** System prompt. `persona.md` in the folder wins over this field. */
  persona: string
  /** Stylesheet filename inside the theme folder, or null for none. */
  css: string | null
  /** Resolved absolute URL of the theme folder, e.g. `/themes/stark`. */
  dir: string
}

export const PHASES: readonly Phase[] = [
  'offline', 'boot', 'dormant', 'waking', 'listening', 'thinking', 'tooling', 'speaking',
]

const THEMES_ROOT = '/themes'

/**
 * The floor every theme stands on. A manifest that omits a field gets this
 * one, so the smallest useful theme.json is `{ "name": "…" }`.
 */
const DEFAULTS: Omit<ThemeManifest, 'id' | 'dir'> = {
  name: 'Assistant',
  copy: {
    title: 'Assistant',
    brand: 'ASSISTANT',
    brandSub: '',
    speaker: 'ASSISTANT',
    wakePhrase: 'computer',
    status: {
      offline: 'OFFLINE',
      boot: 'INITIALISING',
      dormant: 'STANDBY',
      waking: 'ONLINE',
      listening: 'LISTENING',
      thinking: 'PROCESSING',
      tooling: 'ACCESSING SYSTEMS',
      speaking: 'RESPONDING',
    },
    systemsTitle: 'SYSTEMS',
    signalTitle: 'SIGNAL',
    toolKicker: 'accessing',
    ignitionWord: 'INITIALISE',
    ignitionSub: 'click, or clap, to power up',
    voiceSetTail: '',
    audioTest: 'Audio test. If you can hear this, speech output is working.',
  },
  backgroundColor: '#01060c',
  phaseColors: {
    offline: '#0d4a4a',
    boot: '#17b3b3',
    dormant: '#12908f',
    waking: '#5cf2ef',
    listening: '#19d8d2',
    thinking: '#f0a93c',
    tooling: '#a97bff',
    speaking: '#3ef2a8',
  },
  sceneTint: { core: '#19c4c4', hot: '#c9fdff', particles: '#00e5ff' },
  wake: { pattern: '(?:computer)', phrases: ['Computer'], language: 'en-GB' },
  voice: {
    engine: null,
    kokoro: 'bm_george',
    character: 'british-male',
    profile: {
      label: 'George · clean service voice',
      speed: 0.97,
      playbackRate: 1,
      highpassHz: 70,
      lowpassHz: 11_000,
      presenceHz: 2600,
      presenceDb: 2,
      compression: { threshold: -24, ratio: 3, attack: 0.012, release: 0.18 },
    },
  },
  sound: {
    music: false,
    ambient: { tones: [55, 55.6], noise: 0.06, cutoff: 260, level: 0.05 },
  },
  bootDurationMs: 9200,
  register: 'machine',
  suggestion: 'what happened in AI this week',
  persona: '',
  css: 'theme.css',
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Deep-merge a manifest over the defaults, one level into the nested objects.
 *
 * Arrays and scalars replace wholesale — a theme listing two wake phrases means
 * two, not two plus the defaults. Anything of the wrong shape is dropped rather
 * than coerced: a broken field should leave a working default behind it, not a
 * half-applied one.
 */
function merge<T>(base: T, patch: unknown): T {
  if (!isObject(patch)) return base
  const out = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    const current = out[key]
    if (isObject(current) && isObject(value)) out[key] = merge(current, value)
    else if (typeof current === typeof value || current === null) out[key] = value
  }
  return out as T
}

function normalise(id: string, raw: unknown): ThemeManifest {
  const merged = merge(DEFAULTS, raw)
  if (merged.voice.engine !== 'kokoro' && merged.voice.engine !== 'system') {
    merged.voice = { ...merged.voice, engine: null }
  }
  if (isObject(raw) && raw.css === null) merged.css = null
  if (!Number.isFinite(merged.bootDurationMs) || merged.bootDurationMs < 0) {
    merged.bootDurationMs = DEFAULTS.bootDurationMs
  }
  return { ...merged, id, dir: `${THEMES_ROOT}/${id}` }
}

/** Folder names only — no traversal, no absolute URLs from a manifest. */
const isThemeId = (value: string): boolean => /^[a-z0-9][a-z0-9_-]*$/i.test(value)

async function json(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json()
}

let available: string[] = []
let active: ThemeManifest | null = null

/** Every theme found in public/themes, in folder order. */
export const themeIds = (): readonly string[] => available

/**
 * The live theme. Safe to call at module scope anywhere downstream of the
 * dynamic import in main.tsx, which is everything except main.tsx itself.
 */
export function activeTheme(): ThemeManifest {
  if (!active) throw new Error('activeTheme() before bootstrapTheme() resolved')
  return active
}

/** Resolve a path inside the active theme's folder. */
export const themeAsset = (path: string): string => `${activeTheme().dir}/${path}`

const STORAGE_KEY = 'jarvis.theme'

/**
 * Which theme to run.
 *
 * `?theme=hal` wins and sticks, so a dropped-in folder can be tried without
 * editing config.toml and without losing it on the next reload. VITE_THEME is
 * the configured default underneath that.
 */
function requestedId(): string | null {
  let chosen: string | null = null
  try {
    const query = new URLSearchParams(location.search).get('theme')
    if (query && isThemeId(query)) {
      localStorage.setItem(STORAGE_KEY, query)
      return query
    }
    chosen = localStorage.getItem(STORAGE_KEY)
  } catch {
    // Private-mode storage denial is not a reason to refuse to start.
  }
  if (chosen && isThemeId(chosen)) return chosen
  const configured = (import.meta.env.VITE_THEME ?? '').trim()
  return configured && isThemeId(configured) ? configured : null
}

/**
 * Which theme to run when nothing has asked for one. The index is in folder
 * order, so without this the default would be whichever theme sorts first —
 * which is not a decision an alphabet should be making.
 */
const DEFAULT_THEME = 'stark'

const fallbackId = (): string =>
  available.includes(DEFAULT_THEME) ? DEFAULT_THEME : available[0]

/**
 * Load the theme's stylesheet and wait for it.
 *
 * Waiting matters: mounting before the sheet lands shows one frame of the stock
 * cyan HUD in a theme that is meant to be red, and that frame is exactly the
 * one a camera catches.
 */
function loadCss(href: string): Promise<void> {
  return new Promise((resolve) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.dataset.theme = 'active'
    // A missing or broken sheet is a theme that looks stock, not a dead app.
    link.addEventListener('load', () => resolve(), { once: true })
    link.addEventListener('error', () => resolve(), { once: true })
    document.head.append(link)
  })
}

/**
 * Discover the installed themes, pick one, and apply everything that has to be
 * in place before the first render: the data-theme attribute the stylesheets
 * key off, the tab title, the browser chrome colour and the stylesheet itself.
 */
export async function bootstrapTheme(): Promise<ThemeManifest> {
  if (active) return active

  const index = await json(`${THEMES_ROOT}/index.json`).catch(() => null)
  available = Array.isArray(index) ? index.filter((v): v is string => typeof v === 'string' && isThemeId(v)) : []
  if (!available.length) throw new Error('no themes found in public/themes')

  const wanted = requestedId()
  const id = wanted && available.includes(wanted) ? wanted : fallbackId()
  if (wanted && wanted !== id) {
    console.warn(`[jarvis] theme "${wanted}" is not installed — using "${id}".`)
  }

  const manifest = normalise(id, await json(`${THEMES_ROOT}/${id}/theme.json`))

  // persona.md is the authoring-friendly half of the manifest: a system prompt
  // is a page of prose and does not belong on one JSON line. The html check is
  // not paranoia — a dev server that answers a missing file with the SPA shell
  // would otherwise make the index page the assistant's personality.
  const persona = await fetch(`${manifest.dir}/persona.md`, { cache: 'no-cache' })
    .then((res) => {
      const type = res.headers.get('content-type') ?? ''
      return res.ok && type.startsWith('text/') && !type.includes('html') ? res.text() : ''
    })
    .catch(() => '')
  if (persona.trim()) manifest.persona = persona.trim()

  active = manifest

  document.documentElement.dataset.theme = id
  document.title = manifest.copy.title
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', manifest.backgroundColor)

  if (manifest.css) await loadCss(`${manifest.dir}/${manifest.css}`)
  const loadPackage = packages[`../../public/themes/${id}/theme.tsx`]
  if (loadPackage) {
    try {
      const candidate = (await loadPackage()).default
      if (!isObject(candidate)) throw new Error('theme.tsx must default-export a theme package')
      implementation = candidate
    } catch (error) {
      console.warn(`[jarvis] theme "${id}" module failed to load; using defaults.`, error)
    }
  }
  return manifest
}
