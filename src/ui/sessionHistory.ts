import { currentConversationId, openConversation, setSessionSource, startNewConversation, syncSessions, warmBridge, watchConversation } from '../lib/bridge'
import { usingBridge } from '../lib/brain'
import { BRIDGE_WS_URL, THEME } from '../config'
import { createSessionHistory, loadSessions, startupSession, type ChatSession } from '../lib/sessions'
import { useStore } from '../store'

setSessionSource(loadSessions)
const ACTIVE_KEY = `jarvis-active-session:${THEME}:${usingBridge ? BRIDGE_WS_URL : 'direct'}`
let activeId: string | null = null
try { activeId = sessionStorage.getItem(ACTIVE_KEY) } catch {}
const lastSession = startupSession(loadSessions(), { activeId, conversationId: currentConversationId() })
export const sessionHistory = createSessionHistory(useStore, { onSave: syncSessions })
const rememberActive = () => {
  try { sessionStorage.setItem(ACTIVE_KEY, sessionHistory.getSnapshot().currentId) } catch {}
}
const unremember = sessionHistory.subscribe(rememberActive)
let reopening = false
const unwatch = watchConversation((id) => {
  if (usingBridge && !reopening) sessionHistory.attachConversation(id)
})

export async function reopenHistorySession(session: ChatSession | null) {
  if (reopening) throw new Error('A conversation is already being loaded.')
  reopening = true
  useStore.setState({ sessionLoading: true })
  sessionHistory.flush()
  try {
    const conversationId = usingBridge ? await (session ? openConversation(session) : startNewConversation()) : ''
    const showTurns = (turns: ChatSession['turns']) => useStore.setState({ turns })
    if (!session) sessionHistory.startNew(showTurns)
    else if (!sessionHistory.reopen(session.id, showTurns)) {
      throw new Error('The selected session is no longer available.')
    }
    if (conversationId) sessionHistory.attachConversation(conversationId)
  } finally {
    reopening = false
    if (usingBridge && currentConversationId()) sessionHistory.attachConversation(currentConversationId())
    useStore.setState({ sessionLoading: false })
  }
}

let startup: Promise<ChatSession | null> | null = null
export function restoreLastSession(): Promise<ChatSession | null> {
  startup ??= (async () => {
    if (lastSession) await reopenHistorySession(lastSession)
    else if (usingBridge) await warmBridge()
    rememberActive()
    return lastSession
  })()
  return startup
}

// Debounced saves would otherwise lose the last streamed tokens on reload.
window.addEventListener('pagehide', sessionHistory.flush)

import.meta.hot?.dispose(() => {
  unremember()
  unwatch()
  window.removeEventListener('pagehide', sessionHistory.flush)
  sessionHistory.stop()
})
