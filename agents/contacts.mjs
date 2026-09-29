import { readFileSync, renameSync, writeFileSync } from 'node:fs'

/**
 * People the user has contacted before. A message to anyone else needs the
 * user's yes; each yes adds them here. Starts empty unless seeded by hand or
 * from a mail server, so the first message to anyone asks.
 */
export function createContacts(file) {
  let cache = null
  const load = () => {
    try {
      cache = new Set(JSON.parse(readFileSync(file, 'utf8')).map((s) => String(s).toLowerCase()))
    } catch {
      cache = new Set()
    }
    return cache
  }
  return {
    get: () => cache ?? load(),
    add(list) {
      const next = new Set([...(cache ?? load()), ...list.map((s) => String(s).toLowerCase())])
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify([...next].sort(), null, 2) + '\n')
      renameSync(tmp, file)
      cache = next
    },
  }
}
