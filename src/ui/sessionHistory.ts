import { createSessionHistory } from '../lib/sessions'
import { useStore } from '../store'

export const sessionHistory = createSessionHistory(useStore)

// Debounced saves would otherwise lose the last streamed tokens on reload.
window.addEventListener('pagehide', sessionHistory.flush)

import.meta.hot?.dispose(() => {
  window.removeEventListener('pagehide', sessionHistory.flush)
  sessionHistory.stop()
})
