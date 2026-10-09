import { readFileSync, renameSync, writeFileSync } from 'node:fs'

/**
 * People the user has contacted before. A message to anyone else needs the
 * user's yes; each yes adds them here. Starts empty unless seeded by hand or
 * from a mail server, so the first message to anyone asks.
 */
export function createContacts(file) {
  let cache = null
  /** Load known contacts once, using an empty set when no list is available. */
  const load = () => {
    try {
      cache = new Set(JSON.parse(readFileSync(file, 'utf8')).map((s) => String(s).toLowerCase()))
    } catch {
      cache = new Set()
    }
    return cache
  }
  return {
    /** Return cached contacts or load the persisted list on first use. */
    get: () => cache ?? load(),
    /** Add approved recipients and atomically persist the normalized set. */
    add(list) {
      const next = new Set([...(cache ?? load()), ...list.map((s) => String(s).toLowerCase())])
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify([...next].sort(), null, 2) + '\n')
      renameSync(tmp, file)
      cache = next
    },
  }
}
