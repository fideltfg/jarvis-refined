import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadPtt, savePtt, bindingLabel, isReservedKey } from './ptt.ts'

const KEY = 'jarvis-ptt'
const DEFAULT = { kind: 'key', code: 'AltRight' }

/** A localStorage good enough for these tests, and breakable on demand. */
function storage({ broken = false } = {}) {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => {
      if (broken) throw new Error('storage unavailable')
      return map.has(k) ? map.get(k) : null
    },
    setItem: (k, v) => {
      if (broken) throw new Error('storage unavailable')
      map.set(k, String(v))
    },
    removeItem: (k) => map.delete(k),
  }
  return map
}

// -- loading ----------------------------------------------------------------

test('nothing stored means off, holding Right Alt', () => {
  storage()
  assert.deepEqual(loadPtt(), { enabled: false, binding: DEFAULT })
})

test('a saved preference survives the round trip', () => {
  const map = storage()
  savePtt({ enabled: true, binding: { kind: 'key', code: 'Space' } })
  assert.ok(map.has(KEY))
  assert.deepEqual(loadPtt(), { enabled: true, binding: { kind: 'key', code: 'Space' } })

  savePtt({ enabled: true, binding: { kind: 'mouse', button: 3 } })
  assert.deepEqual(loadPtt(), { enabled: true, binding: { kind: 'mouse', button: 3 } })
})

test('only a literal true enables it', () => {
  const map = storage()
  for (const enabled of [1, 'true', null, undefined]) {
    map.set(KEY, JSON.stringify({ enabled, binding: DEFAULT }))
    assert.equal(loadPtt().enabled, false, String(enabled))
  }
})

test('a binding that later became a hotkey falls back to the default', () => {
  const map = storage()
  map.set(KEY, JSON.stringify({ enabled: true, binding: { kind: 'key', code: 'KeyA' } }))
  assert.deepEqual(loadPtt(), { enabled: true, binding: DEFAULT })
})

test('the primary mouse button is never a binding', () => {
  const map = storage()
  for (const button of [0, -1, 1.5, '2', null]) {
    map.set(KEY, JSON.stringify({ enabled: true, binding: { kind: 'mouse', button } }))
    assert.deepEqual(loadPtt().binding, DEFAULT, String(button))
  }
})

test('a malformed binding does not take the defaults down with it', () => {
  const map = storage()
  for (const binding of [null, {}, 'AltRight', { kind: 'key' }, { kind: 'gamepad', code: 'A' }]) {
    map.set(KEY, JSON.stringify({ enabled: true, binding }))
    assert.deepEqual(loadPtt().binding, DEFAULT, JSON.stringify(binding))
  }
})

test('corrupt storage reads as defaults rather than throwing', () => {
  const map = storage()
  map.set(KEY, '{ not json')
  assert.deepEqual(loadPtt(), { enabled: false, binding: DEFAULT })
})

test('storage being unavailable is survivable both ways', () => {
  storage({ broken: true })
  assert.deepEqual(loadPtt(), { enabled: false, binding: DEFAULT })
  assert.doesNotThrow(() => savePtt({ enabled: true, binding: DEFAULT }))
})

// -- reserved keys ----------------------------------------------------------

test('keys the interface already uses cannot be bound', () => {
  for (const code of ['Escape', 'KeyK', 'KeyV', 'KeyG', 'KeyA', 'Tab', 'Enter']) {
    assert.ok(isReservedKey(code), code)
  }
  for (const code of ['AltRight', 'Space', 'ControlLeft', 'KeyZ', 'F13']) {
    assert.ok(!isReservedKey(code), code)
  }
})

// -- labels -----------------------------------------------------------------

test('a binding reads back the way the key is named on the keyboard', () => {
  assert.equal(bindingLabel({ kind: 'key', code: 'KeyZ' }), 'Z')
  assert.equal(bindingLabel({ kind: 'key', code: 'Digit4' }), '4')
  assert.equal(bindingLabel({ kind: 'key', code: 'AltRight' }), 'Right Alt')
  assert.equal(bindingLabel({ kind: 'key', code: 'ControlLeft' }), 'Left Control')
  assert.equal(bindingLabel({ kind: 'key', code: 'CapsLock' }), 'Caps Lock')
  assert.equal(bindingLabel({ kind: 'key', code: 'Space' }), 'Space')
})

test('mouse buttons are named, and an exotic one still gets a label', () => {
  assert.equal(bindingLabel({ kind: 'mouse', button: 1 }), 'Middle mouse')
  assert.equal(bindingLabel({ kind: 'mouse', button: 2 }), 'Right mouse')
  assert.equal(bindingLabel({ kind: 'mouse', button: 3 }), 'Mouse back')
  assert.equal(bindingLabel({ kind: 'mouse', button: 4 }), 'Mouse forward')
  assert.equal(bindingLabel({ kind: 'mouse', button: 9 }), 'Mouse 10')
})

test('every label is something a user could read off the footer', () => {
  for (const code of ['AltRight', 'ShiftLeft', 'Backquote', 'ArrowUp', 'NumpadEnter']) {
    const label = bindingLabel({ kind: 'key', code })
    assert.ok(label.length > 0 && !/[A-Z]{2}/.test(label), `${code} -> ${label}`)
  }
})
