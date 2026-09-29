/**
 * Push-to-talk preferences: whether it is on, and which key or mouse button
 * holds the microphone open. Kept in localStorage so it survives a reload.
 */

export type PttBinding =
  | { kind: 'key'; code: string }
  | { kind: 'mouse'; button: number }

export type PttPrefs = {
  enabled: boolean
  binding: PttBinding
}

const STORE_KEY = 'jarvis-ptt'

/** Right Alt is rarely bound to anything else and sits under the thumb. */
const DEFAULT_BINDING: PttBinding = { kind: 'key', code: 'AltRight' }

/** Keys that already do something else in the app, or cannot be held sanely. */
const RESERVED = new Set([
  'Escape',
  'KeyK',
  'KeyV',
  'KeyG',
  'KeyA',
  'KeyP',
  'KeyT',
  'KeyD',
  'KeyE',
  'KeyX',
  'BracketLeft',
  'BracketRight',
  'Tab',
  'Enter',
])

export function isReservedKey(code: string): boolean {
  return RESERVED.has(code)
}

export function loadPtt(): PttPrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<PttPrefs>
      const b = p.binding
      const binding: PttBinding =
        b?.kind === 'key' && typeof b.code === 'string' && !isReservedKey(b.code)
          ? { kind: 'key', code: b.code }
          : b?.kind === 'mouse' && Number.isInteger(b.button) && b.button > 0
            ? { kind: 'mouse', button: b.button }
            : DEFAULT_BINDING
      return { enabled: p.enabled === true, binding }
    }
  } catch {
    /* corrupt or unavailable storage falls back to defaults */
  }
  return { enabled: false, binding: DEFAULT_BINDING }
}

export function savePtt(p: PttPrefs): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p))
  } catch {
    /* private mode — the setting just won't persist */
  }
}

const MOUSE_NAMES: Record<number, string> = {
  1: 'Middle mouse',
  2: 'Right mouse',
  3: 'Mouse back',
  4: 'Mouse forward',
}

export function bindingLabel(b: PttBinding): string {
  if (b.kind === 'mouse') return MOUSE_NAMES[b.button] ?? `Mouse ${b.button + 1}`
  const c = b.code
  if (c.startsWith('Key')) return c.slice(3)
  if (c.startsWith('Digit')) return c.slice(5)
  const side = /(Left|Right)$/.exec(c)
  if (side) return `${side[1]} ${c.slice(0, -side[1].length)}`
  return c.replace(/([a-z])([A-Z])/g, '$1 $2')
}
