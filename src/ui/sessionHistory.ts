import { setSessionSource, syncSessions } from '../lib/bridge'
import { createSessionHistory, loadSessions } from '../lib/sessions'
import { useStore } from '../store'

setSessionSource(loadSessions)
export const sessionHistory = createSessionHistory(useStore, { onSave: syncSessions })

// Debounced saves would otherwise lose the last streamed tokens on reload.
window.addEventListener('pagehide', sessionHistory.flush)

import.meta.hot?.dispose(() => {
  window.removeEventListener('pagehide', sessionHistory.flush)
  sessionHistory.stop()
})
