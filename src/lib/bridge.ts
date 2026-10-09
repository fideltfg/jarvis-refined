import type { AskHandlers } from './anthropic'
import type { Attachment } from './attachments'
import type { ChatSession } from './sessions'
import type { Schedule, ScheduleRequest } from './schedules'
import type { AgentBoardData, AgentGoal, AgentProfile, AgentProfileRequest, Blade, Panel, SessionAgent } from '../store'
import type { AgentEvent } from './announce'
import { BRIDGE_WS_URL, THEME } from '../config'
import { askHiddenSession } from './hidden-session'
import { formatStartupStatus, renderStartupStatus, summarizeStartupStatus, type StartupSnapshot } from './startup-status'

const CONVERSATION_KEY = `jarvis-conversation:${BRIDGE_WS_URL}:${THEME}`
let conversationId = ''
try {
  conversationId = sessionStorage.getItem(CONVERSATION_KEY) ?? ''
} catch {}

const conversationListeners = new Set<(id: string) => void>()
/** Return the opaque conversation checkpoint id for this browser tab. */
export const currentConversationId = () => conversationId
/** Subscribe to checkpoint changes and immediately deliver the current id. */
export function watchConversation(listener: (id: string) => void) {
  conversationListeners.add(listener)
  if (conversationId) listener(conversationId)
  return () => { conversationListeners.delete(listener) }
}

/**
 * The bridge builds its agent session once per socket, persona included, so the
 * theme has to arrive with the connection rather than with each question.
 */
function socketUrl(): string {
  const url = new URL(BRIDGE_WS_URL)
  url.searchParams.set('theme', THEME)
  if (conversationId) url.searchParams.set('conversation', conversationId)
  return url.toString()
}

/**
 * Client for the local bridge (see bridge/server.mjs).
 *
 * Same `ask()` shape as the browser-direct path, so App.tsx doesn't care which
 * brain is behind it. The difference is what's reachable: this one runs on your
 * machine, so every MCP server in your Claude Code config is in play.
 *
 * The bridge checkpoints conversation state independently of the socket and
 * resumes it using the opaque ID kept in this tab's session storage.
 */

/** Anything the bridge sends. Deliberately loose — a frame from a future
 *  bridge build should be ignored, not crash the turn. */
type Frame = {
  type?: string
  delta?: string
  name?: string
  text?: string
  message?: string
  panel?: Panel
  blade?: Blade
  event?: AgentEvent
  op?: string
  args?: unknown
  id?: string
  ask?: string
  reason?: string
  mode?: string
  seconds?: number
  when?: string
  servers?: Array<string | { name?: string }>
  available?: string[]
  selected?: string
  models?: Record<string, string[]>
  board?: AgentBoardData | null
  online?: boolean
  status?: string
  agents?: SessionAgent[]
}

/** Every question gets an id so its answer can be told from anyone else's. */
let askSeq = 0
let activeAskId = ''
let availableProviders = ['claude']
let selectedProvider = localStorage.getItem('jarvis-provider') || 'claude'
const providerListeners = new Set<(available: string[], selected: string) => void>()

/** What each provider can run, default first, as the bridge reports it. */
let providerModels: Record<string, string[]> = {}

/** The model picked for each provider, remembered across reloads. An empty
 *  entry means the provider's default. */
let chosenModels: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem('jarvis-models') || '{}')
  } catch {
    return {}
  }
})()

/** The chosen model if the bridge still offers it, otherwise the default. */
function modelFor(provider: string) {
  const models = providerModels[provider] ?? []
  return models.includes(chosenModels[provider]) ? chosenModels[provider] : (models[0] ?? '')
}

/** Notify provider subscribers after available or selected model state changes. */
function notifyProviders() {
  for (const listener of providerListeners) listener(availableProviders, selectedProvider)
}

/** Return the selected provider and its currently valid model choice. */
export function providerState() {
  return {
    available: availableProviders,
    selected: selectedProvider,
    models: providerModels[selectedProvider] ?? [],
    model: modelFor(selectedProvider),
  }
}

/** Persist a model only when the selected provider currently offers it. */
export function selectModel(model: string) {
  if (!(providerModels[selectedProvider] ?? []).includes(model)) return
  chosenModels = { ...chosenModels, [selectedProvider]: model }
  localStorage.setItem('jarvis-models', JSON.stringify(chosenModels))
  notifyProviders()
}

/** Subscribe to provider choices and receive the current selection immediately. */
export function watchProviders(fn: (available: string[], selected: string) => void) {
  providerListeners.add(fn)
  fn(availableProviders, selectedProvider)
  return () => { providerListeners.delete(fn) }
}

/** Select and persist an available provider, then notify its subscribers. */
export function selectProvider(provider: string) {
  if (!availableProviders.includes(provider)) return
  selectedProvider = provider
  localStorage.setItem('jarvis-provider', provider)
  notifyProviders()
}

let socket: WebSocket | null = null
let connecting: Promise<WebSocket> | null = null

/** Server names reported by the bridge, for the HUD readout. */
let servers: string[] = []
export const bridgeServers = () => servers

/** The list arrives twice — once from config, once with live status — so the
 *  HUD subscribes rather than reading it a single time at boot. */
let onServers: ((s: string[]) => void) | null = null
/** Register the callback that receives bridge MCP server names. */
export function watchServers(fn: (s: string[]) => void) {
  onServers = fn
}

/** Panels arrive out of band — they're pushed while a turn is in flight,
 *  not returned by it. */
let onPanel: ((panel: Panel) => void) | null = null
/** Register the receiver for panels pushed out of band by the bridge. */
export function watchPanels(fn: (panel: Panel) => void) {
  onPanel = fn
}

/**
 * The latest board, kept because it usually arrives before anyone is
 * listening: the socket opens on page load, the bridge sends a snapshot a
 * moment later, and the app only subscribes once it is powered on. Without
 * this the snapshot was dropped and the board stayed empty until the next
 * agent event happened to arrive.
 */
let lastAgents: { board: AgentBoardData | null; online: boolean } | null = null
let onAgents: ((board: AgentBoardData | null, online: boolean) => void) | null = null
/** Subscribe to the latest board and immediately replay a cached snapshot. */
export function watchAgents(fn: (board: AgentBoardData | null, online: boolean) => void) {
  onAgents = fn
  if (lastAgents) fn(lastAgents.board, lastAgents.online)
}

let onAgentEvent: ((event: AgentEvent) => void) | null = null
/** Register the receiver for live agent-service events. */
export function watchAgentEvents(fn: (event: AgentEvent) => void) {
  onAgentEvent = fn
}

/** The session's subagents, kept for the same reason as the board above: a turn
 *  can dispatch one before the app has subscribed. */
let lastSessionAgents: SessionAgent[] | null = null
let onSessionAgents: ((agents: SessionAgent[]) => void) | null = null
/** Subscribe to active session subagents and replay the cached list if present. */
export function watchSessionAgents(fn: (agents: SessionAgent[]) => void) {
  onSessionAgents = fn
  if (lastSessionAgents) fn(lastSessionAgents)
}

/** Mirrors saved chat history to the bridge so JARVIS can search it. */
let sessionSource: (() => unknown[]) | null = null
export function syncSessions(sessions?: unknown[]) {
  const payload = sessions ?? sessionSource?.()
  if (payload && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'sessions_sync', sessions: payload }))
  }
}
/** Provide the history source used whenever the bridge announces readiness. */
export function setSessionSource(fn: () => unknown[]) {
  sessionSource = fn
}

/** Send an approval decision to the bridge when its socket is open. */
export function decideApproval(id: string, decision: 'approve' | 'deny') {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'agent_decide', id, decision }))
  }
}

let scheduleRequestSeq = 0
/** Request schedule creation, listing, or lifecycle changes from the bridge. */
export function scheduleRequest(request: ScheduleRequest): Promise<Schedule | Schedule[]> {
  return commandRequest('schedule', request, 'schedules')
}

/** Send a typed profile operation and resolve its correlated service response. */
export function profileRequest(request: { action: 'list' }): Promise<AgentProfile[]>
export function profileRequest(request: { action: 'skills' }): Promise<import('./board').InstalledSkill[]>
export function profileRequest(request: { action: 'create'; profile: import('./board').AgentProfileInput }): Promise<AgentProfile>
export function profileRequest(request: { action: 'update'; profileId: string; changes: Partial<import('./board').AgentProfileInput> }): Promise<AgentProfile>
export function profileRequest(request: { action: 'delete'; profileId: string }): Promise<{ id: string; deleted: true }>
export function profileRequest(request: { action: 'run'; profileId: string }): Promise<AgentGoal>
export function profileRequest(request: AgentProfileRequest): Promise<AgentProfile[] | AgentProfile | AgentGoal | import('./board').InstalledSkill[] | { id: string; deleted: true }> {
  return commandRequest('profile', request, 'agent profiles')
}

/** Send a blocker reply and optional resume request for one goal. */
export function goalRequest(request: { goalId: string; info: string; resume: boolean }): Promise<{ id: string; status: string }> {
  return commandRequest('goal', request, 'agent board')
}

/** What the service reports back once a goal and its task history are gone. */
export type GoalErased = { id: string; deleted: true; tasks: number }
/** Control or erase a goal and return its resulting lifecycle state. */
export function goalControlRequest(request: { goalId: string; action: 'pause' | 'resume' | 'abandon' }): Promise<{ id: string; status: string }>
export function goalControlRequest(request: { goalId: string; action: 'erase' }): Promise<GoalErased>
export function goalControlRequest(request: { goalId: string; action: 'pause' | 'resume' | 'abandon' | 'erase' }): Promise<{ id: string; status: string } | GoalErased> {
  return commandRequest('goal_control', request, 'agent board')
}

/** Submit structured answers for a blocked task's decision request. */
export function decisionRequest(request: { goalId: string; taskId: string; answers: Record<string, string>; note?: string }): Promise<{ id: string; status: string }> {
  return commandRequest('decision', request, 'agent decision')
}

/** Approve or decline a goal-level decision blocker. */
export function goalDecisionRequest(request: { goalId: string; decision: 'approve' | 'not_approve'; note?: string }): Promise<{ id: string; status: string }> {
  return commandRequest('goal_decision', request, 'agent approval decision')
}

export type WorkFile = { path: string; size: number; modified: string; scope: string; owner: string; task: string | null; preview: 'text' | 'image' | 'pdf' | null }
/** List generated work files or delete one permitted file through the bridge. */
export function filesRequest(request: { action: 'list' }): Promise<{ files: WorkFile[]; truncated: boolean; canDelete: boolean }>
export function filesRequest(request: { action: 'delete'; path: string }): Promise<{ path: string; deleted: true }>
export function filesRequest(request: { action: 'list' | 'delete'; path?: string }): Promise<{ files: WorkFile[]; truncated: boolean; canDelete: boolean } | { path: string; deleted: true }> {
  return commandRequest('files', request, 'files')
}

export type TaskReports = { result: unknown; failure: unknown; files: string[] }
/** Retrieve task history, a saved report, or a referenced source file. */
export function reportRequest(request: { action: 'history' }): Promise<AgentBoardData>
export function reportRequest(request: { action: 'task'; taskId: string; file?: string }): Promise<TaskReports | { file: string; content: string }>
export function reportRequest(request: { action: 'reference'; taskId: string; index: number }): Promise<{ file: string; content: string }>
export function reportRequest(request: { action: 'history' | 'task' | 'reference'; taskId?: string; file?: string; index?: number }): Promise<AgentBoardData | TaskReports | { file: string; content: string }> {
  return commandRequest('report', request, 'agent reports')
}

/** Send one correlated command and reject on disconnect, timeout, or API error. */
function commandRequest<Result>(kind: 'schedule' | 'goal' | 'goal_control' | 'decision' | 'goal_decision' | 'report' | 'profile' | 'files', request: object, surface: string): Promise<Result> {
  const ws = socket
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`The bridge is disconnected. Reconnect before changing ${surface}.`))
  const requestId = `${kind}-${Date.now()}-${++scheduleRequestSeq}`
  return new Promise((resolve, reject) => {
    /** Remove this request's listeners and timeout after any terminal outcome. */
    /** Remove listeners and clear shared pending state after a terminal frame. */
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
    }
    /** Reject with a recovery hint if the socket closes before its reply. */
    const onClose = () => { cleanup(); reject(new Error(`The bridge disconnected. Refresh ${surface} before retrying; the change may have been saved.`)) }
    /** Resolve only the response matching this request kind and id. */
    const onMessage = (event: MessageEvent) => {
      let reply
      try { reply = JSON.parse(event.data as string) } catch { return }
      if (reply.type !== `${kind}_reply` || reply.requestId !== requestId) return
      cleanup()
      if (reply.error) reject(new Error(reply.error))
      else resolve(reply.result)
    }
    // Bound requests so a lost bridge reply cannot leave UI controls pending forever.
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${kind === 'schedule' ? 'Schedule' : 'Goal'} request timed out. Refresh ${surface} before retrying; the change may have been saved.`)) }, 30000)
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    try { ws.send(JSON.stringify({ type: `${kind}_request`, requestId, ...request })) }
    catch (error) { cleanup(); reject(error) }
  })
}

/**
 * The one request the bridge makes of us rather than the other way round.
 *
 * Everything else on this socket is pushed at the browser and needs no answer.
 * A camera frame has to travel back, so this handler is registered by the app
 * and its result is returned against the request's id.
 */
export type CaptureRequest = {
  /** 'look' for a single frame, 'watch' for a grid over time. */
  mode: 'look' | 'watch'
  reason: string
  seconds: number
  /** 'now' records forward; 'past' reads the rolling buffer. */
  when: 'now' | 'past'
}
export type CaptureResult = { data?: string; mimeType?: string; error?: string }

let onCapture: ((req: CaptureRequest) => Promise<CaptureResult>) | null = null
/** Register the browser camera handler used to answer bridge capture frames. */
export function watchCapture(fn: (req: CaptureRequest) => Promise<CaptureResult>) {
  onCapture = fn
}

/** Blades arrive the same way panels do — pushed mid-turn, so the article is
 *  already open as he starts the sentence about it. */
let onBlade: ((blade: Blade) => void) | null = null
/** Register the receiver for blades pushed during a spoken turn. */
export function watchBlades(fn: (blade: Blade) => void) {
  onBlade = fn
}

/** Commands that redress the interface — theme, reactor, orbits, effects. Same
 *  out-of-band route as panels: JARVIS issues them while he is still mid-answer
 *  so the change is on screen as he says it, which means they cannot ride back
 *  on the turn's result. The op/args pair stays untyped here on purpose — this
 *  module is a transport, and the store is where the shape is decided. */
let onUi: ((op: string, args: any) => void) | null = null
/** Register the receiver for out-of-band interface operations. */
export function watchUi(fn: (op: string, args: any) => void) {
  onUi = fn
}

/**
 * Connection state, for the UI.
 *
 *   'open'        — first connection of the page.
 *   'lost'        — the socket died; saved conversation state is retained.
 *   'reconnected' — transport is back, awaiting recovery status.
 *   'restored'    — the bridge restored this tab's conversation checkpoint.
 *   'reset'       — the requested checkpoint was unavailable.
 */
export type ConnectionState = 'open' | 'lost' | 'reconnected' | 'restored' | 'reset' | 'storage_error'
let onConnection: ((state: ConnectionState) => void) | null = null
/** Subscribe to connection and conversation-recovery state changes. */
export function watchConnection(fn: (state: ConnectionState) => void) {
  onConnection = fn
}

/** Report whether the bridge WebSocket is currently open. */
export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Create a promise together with its externally callable resolver. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    // Capture the resolver so socket events can announce readiness later.
    resolve = r
  })
  return { promise, resolve }
}

/** Resolved by the socket-level dispatcher on the first `ready` of the current
 *  connection. Re-armed per connection so a reconnect re-announces. */
let firstReady = deferred()
let conversationReady = deferred()
let conversationStatus = ''
let openingConversation = false

let everConnected = false

/** Backoff for the automatic re-dial, capped while the bridge is unavailable. */
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 8000]
let attempt = 0
let reconnectTimer = 0
let probeConnection: (() => void) | null = null
const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 10_000

/** Schedule the next automatic connection attempt using capped backoff. */
function scheduleReconnect() {
  const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)]
  attempt += 1
  clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(() => {
    // Retry dialing and reschedule if the bridge is still unavailable.
    void connect().catch(() => scheduleReconnect())
  }, delay)
}

/** Probe an open socket or reconnect when the page becomes active again. */
function resumeConnection() {
  if (!everConnected) return
  if (socket?.readyState === WebSocket.OPEN) {
    probeConnection?.()
  } else {
    clearTimeout(reconnectTimer)
    void connect().catch(() => scheduleReconnect())
  }
}

window.addEventListener('online', resumeConnection)
window.addEventListener('focus', resumeConnection)
// Resume heartbeat checks when a background tab becomes visible again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeConnection()
})

/**
 * One message listener per socket, owning everything that isn't part of a
 * turn. It used to live inside warmBridge, bound to that one socket: after any
 * reconnect the SYSTEM rail froze for the life of the page, and every extra
 * warmBridge() call leaked another listener onto the same socket.
 */
function dispatch(ws: WebSocket) {
  // Keep bridge state and pushed UI events synchronized for this socket.
  ws.addEventListener('message', (e: MessageEvent) => {
    let msg: Frame
    try {
      msg = JSON.parse(e.data as string)
    } catch {
      return
    }

    if (msg.type === 'conversation' && msg.id) {
      if (socket !== ws) return
      conversationId = msg.id
      try {
        sessionStorage.setItem(CONVERSATION_KEY, conversationId)
      } catch {}
      conversationStatus = msg.status ?? ''
      conversationReady.resolve()
      // Notify every subscriber after the active checkpoint id changes.
      conversationListeners.forEach((listener) => listener(conversationId))
      if (msg.status === 'restored') onConnection?.('restored')
      else if (msg.status === 'unavailable') onConnection?.('reset')
      else if (msg.status === 'storage_error') onConnection?.('storage_error')
    } else if (msg.type === 'ready') {
      // The bridge announces immediately on connect from Claude Code's config,
      // then again with live status once the agent initialises. Keep listening
      // so the later, more accurate list wins.
      servers = (msg.servers ?? [])
        // Accept both early string names and later server status objects.
        .map((server) => (typeof server === 'string' ? server : (server.name ?? '')))
        // Drop unnamed entries before publishing the server list.
        .filter(Boolean)
      onServers?.(servers)
      firstReady.resolve()
      syncSessions()
    } else if (msg.type === 'providers' && msg.available && msg.selected) {
      if (msg.ask && msg.ask !== activeAskId) return
      availableProviders = msg.available
      if (msg.models) providerModels = msg.models
      if (msg.ask || !availableProviders.includes(selectedProvider)) {
        selectedProvider = msg.selected
        localStorage.setItem('jarvis-provider', selectedProvider)
      }
      notifyProviders()
    } else if (msg.type === 'panel' && msg.panel) {
      onPanel?.(msg.panel)
    } else if (msg.type === 'agents') {
      lastAgents = { board: msg.board ?? null, online: msg.online !== false }
      onAgents?.(lastAgents.board, lastAgents.online)
    } else if (msg.type === 'session_agents') {
      lastSessionAgents = msg.agents ?? []
      onSessionAgents?.(lastSessionAgents)
    } else if (msg.type === 'agent_event' && msg.event) {
      onAgentEvent?.(msg.event)
    } else if (msg.type === 'blade' && msg.blade) {
      onBlade?.(msg.blade)
    } else if (msg.type === 'capture' && msg.id) {
      const id = msg.id
      /** Send the camera result against the request id that is waiting. */
      const reply = (payload: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reply', id, ...payload }))
        }
      }
      if (!onCapture) {
        reply({ error: 'The interface has no camera handler.' })
      } else {
        // Always answers, even on failure: the bridge is holding a turn open
        // waiting for this, and a rejection that never arrives is a turn that
        // hangs until the idle timer notices.
        onCapture({
          mode: msg.mode === 'watch' ? 'watch' : 'look',
          reason: msg.reason ?? '',
          seconds: Math.max(2, Math.min(15, Number(msg.seconds) || 6)),
          when: msg.when === 'past' ? 'past' : 'now',
        })
          // Return successful frames or a readable error so no request hangs.
          .then(reply)
          .catch((err) => reply({ error: String(err?.message ?? err) }))
      }
    } else if (msg.type === 'ui' && msg.op) {
      // A `ui` frame with no args is normal — reset and clear take none — so an
      // absent args object is an empty one, not a reason to drop the command.
      onUi?.(msg.op, (msg.args ?? {}) as Record<string, unknown>)
    }
  })
}

/** Reuse or open the bridge socket and resolve once its handshake succeeds. */
function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
  if (connecting) return connecting

  firstReady = deferred()
  conversationReady = deferred()
  conversationStatus = ''

  connecting = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(socketUrl())
    let settled = false
    let heartbeatTimer = 0
    let heartbeatDeadline = 0

    /** Clear liveness state and schedule recovery for the current socket only. */
    const loseConnection = () => {
      clearTimeout(heartbeatTimer)
      clearTimeout(heartbeatDeadline)
      if (socket !== ws) return
      socket = null
      probeConnection = null
      pending?.fail?.(new Error('The bridge disconnected mid-answer. Ask me to continue after reconnecting.'))
      onConnection?.('lost')
      scheduleReconnect()
    }

    /** Send a ping and start a deadline for the matching pong response. */
    const probe = () => {
      if (socket !== ws || ws.readyState !== WebSocket.OPEN) return
      clearTimeout(heartbeatTimer)
      clearTimeout(heartbeatDeadline)
      heartbeatDeadline = window.setTimeout(() => {
        loseConnection()
        ws.close()
      }, HEARTBEAT_TIMEOUT_MS)
      try {
        ws.send(JSON.stringify({ type: 'ping' }))
      } catch {
        loseConnection()
        ws.close()
      }
    }

    // Keep heartbeat replies separate from the general frame dispatcher.
    ws.addEventListener('message', (event: MessageEvent) => {
      let frame: Frame
      try {
        frame = JSON.parse(event.data as string)
      } catch {
        return
      }
      if (frame.type !== 'pong' || socket !== ws) return
      clearTimeout(heartbeatDeadline)
      clearTimeout(heartbeatTimer)
      heartbeatTimer = window.setTimeout(probe, HEARTBEAT_INTERVAL_MS)
    })

    /**
     * Every terminal path runs through here, and clearing `connecting` is the
     * whole point. The timeout used to reject without clearing it, which
     * bricked the client: the fast path above hands that same dead promise to
     * every later caller, so one slow start cost you a page reload.
     */
    const settle = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connecting = null
      if (err) reject(err)
      else resolve(ws)
    }

    const timer = setTimeout(() => {
      // Reject a handshake that never opens rather than retaining a dead promise.
      ws.close()
      settle(new Error('Bridge not responding — is `npm run bridge` running?'))
    }, 6000)

    // Mark the socket current, attach dispatch, and release connection waiters.
    ws.onopen = () => {
      socket = ws
      attempt = 0
      clearTimeout(reconnectTimer)
      probeConnection = probe
      heartbeatTimer = window.setTimeout(probe, HEARTBEAT_INTERVAL_MS)
      dispatch(ws)
      settle(null)
      onConnection?.(everConnected ? 'reconnected' : 'open')
      everConnected = true
    }
    ws.onerror = () => {
      /**
       * The browser will not tell us why.
       *
       * A refused handshake and a rejected Origin arrive here identically — no
       * status, no reason, just `error` — and the two have completely different
       * fixes. The old message named only one of them, and confidently: it said
       * to start the bridge. When the real cause was the page being served on a
       * port outside the range the bridge trusts, that advice sent everyone to
       * inspect a process that was running perfectly the whole time.
       *
       * So say both, and put the actual port in front of them, since that is
       * the fact that distinguishes the two cases at a glance.
       */
      settle(
        new Error(
          `Cannot reach the bridge at ${BRIDGE_WS_URL}. Either it is not ` +
            'running (start it with `npm start`), or this page is on a port it ' +
            `refuses — it accepts localhost:5173-5199 and 4173-4199, and this ` +
            `page is on ${location.port || '80'}.`,
        ),
      )
    }
    ws.onclose = () => {
      // A close before open is just a failed dial; after open it's a lost
      // session, and the two want different handling.
      settle(new Error('The bridge closed the connection.'))
      loseConnection()
    }
  })

  return connecting
}

/** Open the socket early so the first "Hey Jarvis" isn't waiting on a handshake. */
export async function warmBridge(): Promise<void> {
  await connect()
  // Don't block startup if the bridge never announces — the dispatcher fills
  // the rail in whenever the list does turn up.
  await Promise.race([
    firstReady.promise,
    // Bound startup waiting; dispatch will publish server names if they arrive later.
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ])
}

/** Replace the active bridge conversation and optionally restore saved turns. */
export async function openConversation(session: ChatSession | null): Promise<string> {
  if (openingConversation) throw new Error('A conversation is already being reopened.')
  openingConversation = true
  const previousId = conversationId
  /** Close the old session and reconnect with the requested checkpoint id. */
  const replaceSocket = (id: string) => {
    const previous = socket
    socket = null
    probeConnection = null
    clearTimeout(reconnectTimer)
    conversationId = id
    try { sessionStorage.setItem(CONVERSATION_KEY, id) } catch {}
    previous?.close()
  }
  try {
    cancel()
    replaceSocket(session?.conversationId ?? '')
    const ws = await connect()
    let timer = 0
    try {
      await Promise.race([
        conversationReady.promise,
        new Promise<void>((_resolve, reject) => {
          // Require explicit confirmation that the bridge found the checkpoint.
          timer = window.setTimeout(() => reject(new Error('The bridge did not confirm conversation recovery.')), 10_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (conversationStatus === 'storage_error') throw new Error('The bridge cannot save conversations.')
    if (session && conversationStatus !== 'restored') {
      const id = `history-${++askSeq}`
      await new Promise<void>((resolve, reject) => {
        /** Remove listeners and timeout once history restoration settles. */
        const cleanup = () => {
          clearTimeout(timer)
          ws.removeEventListener('message', onMessage)
          ws.removeEventListener('close', onClose)
        }
        /** Reject if the socket closes before confirming the restore request. */
        const onClose = () => { cleanup(); reject(new Error('The bridge disconnected while reopening the conversation.')) }
        /** Resolve only when the bridge confirms this restore request id. */
        const onMessage = (event: MessageEvent) => {
          let frame: Frame
          try { frame = JSON.parse(event.data as string) } catch { return }
          if (frame.id !== id) return
          if (frame.type === 'history_restored') { cleanup(); resolve() }
          else if (frame.type === 'history_restore_error') {
            cleanup()
            reject(new Error(frame.message ?? 'The conversation could not be reopened.'))
          }
        }
        // Avoid leaving the reopen UI waiting forever for a lost bridge reply.
        timer = window.setTimeout(() => { cleanup(); reject(new Error('Reopening the conversation timed out.')) }, 10_000)
        ws.addEventListener('message', onMessage)
        ws.addEventListener('close', onClose)
        try {
          ws.send(JSON.stringify({ type: 'restore_history', id, turns: session.turns }))
        } catch (error) {
          cleanup()
          reject(error)
        }
      })
    }
    return conversationId
  } catch (error) {
    replaceSocket(previousId)
    scheduleReconnect()
    throw error
  } finally {
    openingConversation = false
  }
}

/** Start a new bridge checkpoint without restoring any prior transcript. */
export const startNewConversation = () => openConversation(null)

/** Ask a hidden isolated session without replacing the foreground conversation. */
export function askHidden(prompt: string): Promise<{ text: string }> {
  const url = new URL(BRIDGE_WS_URL)
  url.searchParams.set('theme', THEME)
  return askHiddenSession(url.toString(), prompt, {
    provider: selectedProvider,
    model: modelFor(selectedProvider),
  })
}

/** Read startup state in an isolated session and render its text and HTML views. */
export async function readStartupStatus(): Promise<{ text: string; summary: string; html: string }> {
  const url = new URL(BRIDGE_WS_URL)
  url.searchParams.set('theme', THEME)
  const result = await askHiddenSession(url.toString(), '', { provider: '', model: '', statusOnly: true })
  const snapshot = JSON.parse(result.text) as StartupSnapshot
  return { text: formatStartupStatus(snapshot), summary: summarizeStartupStatus(snapshot), html: renderStartupStatus(snapshot) }
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * No frame of any kind for two minutes means the turn is never coming back.
 * Generous on purpose: a long agent run can sit silent through a slow tool,
 * and cutting a real answer off is worse than waiting. What this catches is
 * the case that used to hang forever — the bridge alive but the turn lost.
 */
const IDLE_TIMEOUT_MS = 120_000

/** The turn in flight, so a barge-in can settle it locally. */
let pending: { finish: (fallback?: string) => void; fail?: (err: Error) => void } | null = null

export async function ask(
  prompt: string,
  handlers: AskHandlers,
  attachments: readonly Attachment[] = [],
): Promise<{ text: string; tools: string[] }> {
  if (openingConversation) throw new Error('The conversation is still being reopened.')
  /**
   * A new question supersedes the one in flight.
   *
   * Two concurrent turns genuinely would corrupt each other — both listeners
   * see every delta, and the first 'done' resolves both with the other's text —
   * but refusing the new one was the wrong way to prevent that. It surfaced as
   * "JARVIS is already answering", which is a sentence about this module's
   * bookkeeping rather than about anything the user did, and it contradicts the
   * premise the whole app is built on: say something and it becomes the turn.
   *
   * It fired far more than it looked like it should, because the only thing
   * that cleared the slot was a barge-in — and a barge-in only fires in guard
   * mode. A transcript can arrive well after the speech that produced it: the
   * segment queue means several can be waiting, and their onsets happened while
   * the machine was still listening, when nothing interrupts. So the second
   * utterance of a normal sentence could land on a turn that was already
   * running and simply be refused.
   *
   * Cancelling settles the old promise synchronously, so by the time the code
   * below claims the slot there is nothing left to collide with. The abandoned
   * turn's caller sees its own `stale()` check and stands down quietly.
   */
  if (pending) cancel()

  // Claim the slot in this same tick. connect() below awaits, and two calls
  // made before it settles would otherwise both sail past the check above.
  let cancelledWhileDialling = false
  pending = {
    finish: () => {
      cancelledWhileDialling = true
    },
  }

  let ws: WebSocket
  try {
    ws = await connect()
  } catch (err) {
    pending = null
    throw err
  }

  // Barged in on before the socket was even up. Nothing was ever asked.
  if (cancelledWhileDialling) {
    pending = null
    return { text: '', tools: [] }
  }

  const id = `a${++askSeq}`
  activeAskId = id
  const tools: string[] = []
  let text = ''

  return new Promise((resolve, reject) => {
    let done = false
    let timer = 0

    const cleanup = () => {
      done = true
      pending = null
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }

    /** Resolve with streamed text, falling back to the final result payload. */
    const finish = (fallback = '') => {
      if (done) return
      cleanup()
      // Prefer the streamed text; fall back to the final result if this build
      // didn't emit deltas.
      resolve({ text: (text || fallback).trim(), tools })
    }

    /** Reject the active ask exactly once and release its socket listeners. */
    const fail = (err: Error) => {
      if (done) return
      cleanup()
      reject(err)
    }

    /** Reset the idle deadline whenever a current-turn frame makes progress. */
    const arm = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        // Interrupt server work before rejecting a turn that has gone silent.
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'interrupt' }))
        }
        fail(new Error('The bridge went quiet — that turn was lost, sir.'))
      }, IDLE_TIMEOUT_MS)
    }

    /** Parse current-turn frames and forward text/tools to the caller. */
    const onMessage = (e: MessageEvent) => {
      let msg: Frame
      try {
        msg = JSON.parse(e.data as string)
      } catch {
        arm()
        // A frame we can't read is not a reason to abandon the turn. It used
        // to be: the parse threw inside the listener, nothing settled the
        // promise, and App's `busy` flag stayed true for the life of the page.
        return
      }

      if (msg.type === 'pong') return

      /**
       * Somebody else's answer.
       *
       * A superseded turn keeps streaming for a moment after it is abandoned,
       * and this listener is attached to the socket rather than to a turn — so
       * without this check the tail of the old answer is read as the beginning
       * of the new one. Measured before it existed: ask for ALPHA, barge in,
       * ask for BRAVO, and BRAVO's answer came back as "ALPHA".
       */
      if (msg.ask && msg.ask !== id) return
      arm()

      try {
        switch (msg.type) {
          case 'text':
            text += msg.delta ?? ''
            handlers.onText(msg.delta ?? '')
            break

          case 'tool':
            if (!msg.name) break
            tools.push(msg.name)
            handlers.onTool(prettyToolName(msg.name))
            break

          case 'done':
            finish(msg.text ?? '')
            break

          case 'error':
            fail(new Error(msg.message ?? 'The bridge reported an error.'))
            break
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }

    /** Reject this turn if its socket closes before a terminal response. */
    const onClose = () => {
      fail(new Error('The bridge disconnected mid-answer. Ask me to continue after reconnecting.'))
    }
    /** Convert a socket error into a settled ask failure. */
    const onError = () => {
      fail(new Error('The connection to the bridge failed.'))
    }

    pending = { finish, fail }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    arm()

    try {
      ws.send(JSON.stringify({
        type: 'ask',
        text: prompt,
        id,
        provider: selectedProvider,
        model: modelFor(selectedProvider),
        ...(attachments.length && {
          // Send only the attachment fields accepted by the bridge protocol.
          attachments: attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
        }),
      }))
    } catch (err) {
      // The socket can go into CLOSING between connect() resolving and here.
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Cut JARVIS off mid-answer.
 *
 * Tells the bridge to stop, then settles the in-flight turn here rather than
 * waiting for a 'done' that a barge-in may never produce. Whatever he had
 * already said is returned, so the caller's await always comes back and the
 * transcript keeps the half-sentence the user actually heard.
 */
export function cancel(): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'interrupt' }))
  }
  pending?.finish()
}

/** The older name for `cancel()`. */
export function interrupt(): void {
  cancel()
}

/** `mcp__higgsfield__generate_image` -> `higgsfield · generate image` */
function prettyToolName(raw: string): string {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  return `${server} · ${rest.join(' ').replace(/_/g, ' ')}`
}
