import { useCallback, useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../../../src/config'
import { usingBridge } from '../../../src/lib/brain'

/**
 * The loose-ends window: everything the computer started and did not finish.
 *
 * It reads the ledger the bridge keeps rather than the user's to-do list, so
 * what shows here is the assistant's own debt — unpushed commits, unverified
 * fixes, abandoned searches. Open items first, because the point of the window
 * is to answer "what is left", and finished ones are kept only long enough to
 * confirm they were closed.
 */

type Item = {
  date: string | null
  project: string | null
  action: string
  state: string | null
  status: 'open' | 'partial' | 'done'
}

type Ledger = { items: Item[]; open: number; missing: boolean }

const RANK: Record<Item['status'], number> = { partial: 0, open: 1, done: 2 }
const LABEL: Record<Item['status'], string> = { partial: 'PARTIAL', open: 'OPEN', done: 'CLEARED' }

function LooseEnds({ onClose }: { onClose: () => void }) {
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const read = useCallback((signal?: AbortSignal) => {
    setLoading(true)
    return fetch(`${BRIDGE_HTTP_URL}/memory/loose-ends`, { signal })
      .then((response) => {
        if (!response.ok) throw new Error('The ledger is unavailable')
        return response.json() as Promise<Ledger>
      })
      .then((next) => { setLedger(next); setError('') })
      .catch(() => { if (!signal?.aborted) setError('Could not read the loose-ends ledger.') })
      .finally(() => { if (!signal?.aborted) setLoading(false) })
  }, [])

  useEffect(() => {
    if (!usingBridge) { setLoading(false); return }
    const controller = new AbortController()
    void read(controller.signal)
    return () => controller.abort()
  }, [read])

  const items = ledger ? [...ledger.items].sort((a, b) =>
    RANK[a.status] - RANK[b.status] || (b.date ?? '').localeCompare(a.date ?? '')) : []

  return (
    <section className="lcars-loose-window" role="region" aria-labelledby="lcars-loose-title" onKeyDownCapture={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    }}>
      <header>
        <div>
          <span className="lcars-reactor-eyebrow">COMPUTER / INCOMPLETE WORK</span>
          <h2 id="lcars-loose-title">Loose ends</h2>
        </div>
        <div className="lcars-loose-head-right">
          {ledger && <span className="lcars-loose-count" data-clear={ledger.open === 0 || undefined}>{String(ledger.open).padStart(2, '0')} OPEN</span>}
          <button type="button" className="lcars-loose-refresh" onClick={() => void read()} disabled={loading || !usingBridge}>{loading ? 'READING' : 'REFRESH'}</button>
        </div>
      </header>
      {!usingBridge ? <p className="lcars-loose-empty">The ledger requires the local bridge.</p>
        : error ? <p className="lcars-loose-empty" role="alert">{error}</p>
          : !ledger ? <p className="lcars-loose-empty">Reading ledger...</p>
            : ledger.missing || !items.length ? <p className="lcars-loose-empty">Nothing outstanding. No incomplete work recorded.</p>
              : <ul className="lcars-loose-list">
                {items.map((item, index) => (
                  <li key={`${index}-${item.action}`} className="lcars-loose-row" data-status={item.status}>
                    <span className="lcars-loose-idx">{String(index + 1).padStart(2, '0')}</span>
                    <div className="lcars-loose-main">
                      <strong>{item.action}</strong>
                      {(item.project || item.state) && (
                        <small>{[item.project, item.state].filter(Boolean).join(' — ')}</small>
                      )}
                    </div>
                    <span className="lcars-loose-meta">
                      <b>{LABEL[item.status]}</b>
                      {item.date && <i>{item.date}</i>}
                    </span>
                  </li>
                ))}
              </ul>}
    </section>
  )
}

export default LooseEnds
