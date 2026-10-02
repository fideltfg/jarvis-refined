import { useEffect, useState } from 'react'
import { useStore } from '../store'

export function useBootClock() {
  const phase = useStore((state) => state.phase)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (phase !== 'boot') {
      setElapsed(0)
      return
    }
    const started = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - started), 50)
    return () => clearInterval(id)
  }, [phase])

  return phase === 'boot' ? elapsed : null
}
