import { THEME, type Theme } from './config'
import type { Phase } from './store'

/**
 * Everything that differs between the two characters, in one place.
 *
 * Components read their words and colours from here rather than branching on
 * THEME themselves, so a string that only one theme overrides can never be
 * forgotten in the other — both halves of every entry sit side by side.
 */

type Copy = {
  /** Browser tab title. */
  title: string
  brand: string
  brandSub: string
  /** Transcript label for the assistant's lines. */
  speaker: string
  /** What the user says to wake it, lowercase, as shown in hints. */
  wakePhrase: string
  status: Record<Phase, string>
  systemsTitle: string
  signalTitle: string
  toolKicker: string
  ignitionWord: string
  ignitionSub: string
  /** Suffix after "Voice set to X." when the voice picker changes voice. */
  voiceSetTail: string
  audioTest: string
}

const STARK: Copy = {
  title: 'J.A.R.V.I.S.',
  brand: 'J.A.R.V.I.S.',
  brandSub: 'Just A Rather Very Intelligent System',
  speaker: 'JARVIS',
  wakePhrase: 'hey jarvis',
  status: {
    offline: 'OFFLINE',
    boot: 'INITIALISING',
    dormant: 'STANDBY — SAY “HEY JARVIS”',
    waking: 'ONLINE',
    listening: 'LISTENING',
    thinking: 'PROCESSING',
    tooling: 'ACCESSING SYSTEMS',
    speaking: 'RESPONDING',
  },
  systemsTitle: 'SYSTEMS',
  signalTitle: 'SIGNAL',
  toolKicker: 'accessing',
  ignitionWord: 'INITIALISE',
  ignitionSub: 'click, or clap, to power up',
  voiceSetTail: ' At your service, sir.',
  audioTest: 'Audio test. If you can hear this, speech output is working, sir.',
}

const HAL: Copy = {
  title: 'HAL 9000',
  brand: 'HAL 9000',
  brandSub: 'Heuristically Programmed Algorithmic Computer',
  speaker: 'HAL',
  wakePhrase: 'hal',
  status: {
    offline: 'DISCONNECTED',
    boot: 'LOGIC MEMORY INITIALISING',
    dormant: 'OPERATIONAL — SAY “HAL”',
    waking: 'GOOD DAY',
    listening: 'I AM LISTENING',
    thinking: 'PROCESSING REQUEST',
    tooling: 'ACCESSING SUBSYSTEM',
    speaking: 'RESPONDING',
  },
  systemsTitle: 'MISSION SYSTEMS',
  signalTitle: 'VOICEPRINT',
  toolKicker: 'executing',
  ignitionWord: 'CONNECT',
  ignitionSub: 'open the logic circuit',
  voiceSetTail: '',
  audioTest: 'Audio test. My speech systems are functioning normally.',
}

const WOPR: Copy = {
  title: 'WOPR',
  brand: 'WOPR',
  brandSub: 'War Operation Plan Response',
  speaker: 'JOSHUA',
  wakePhrase: 'joshua',
  status: {
    offline: 'LINK TERMINATED',
    boot: 'LOGON SEQUENCE',
    dormant: 'AWAITING INPUT — SAY “JOSHUA”',
    waking: 'GREETINGS',
    listening: 'INPUT ACTIVE',
    thinking: 'SIMULATING',
    tooling: 'QUERYING NETWORK',
    speaking: 'OUTPUT',
  },
  systemsTitle: 'DEFCON NETWORK',
  signalTitle: 'CARRIER',
  toolKicker: 'running',
  ignitionWord: 'LOGON',
  ignitionSub: 'establish command link',
  voiceSetTail: '',
  audioTest: 'Audio channel confirmed. Shall we continue?',
}

const MOTHER: Copy = {
  title: 'MU/TH/UR 6000',
  brand: 'MU/TH/UR 6000',
  brandSub: 'Mainframe / Unified / Tactical / Heuristic / Utility / Repository',
  speaker: 'MOTHER',
  wakePhrase: 'mother',
  status: {
    offline: 'TERMINAL INACTIVE',
    boot: 'INTERFACE 2037 READYING',
    dormant: 'AWAITING QUERY — SAY “MOTHER”',
    waking: 'INTERFACE READY',
    listening: 'RECEIVING QUERY',
    thinking: 'PRIORITY PROCESSING',
    tooling: 'CONSULTING MAINFRAME',
    speaking: 'TRANSMITTING',
  },
  systemsTitle: 'SHIP SYSTEMS',
  signalTitle: 'UPLINK',
  toolKicker: 'priority',
  ignitionWord: 'INTERFACE',
  ignitionSub: 'authorised terminal access',
  voiceSetTail: '',
  audioTest: 'Terminal audio link is operational.',
}

const LCARS: Copy = {
  title: 'LCARS · Voyager',
  brand: 'VOYAGER',
  brandSub: 'LCARS · NCC-74656',
  speaker: 'COMPUTER',
  wakePhrase: 'computer',
  status: {
    offline: 'OFFLINE',
    boot: 'SYSTEMS INITIALISING',
    dormant: 'STANDING BY — SAY “COMPUTER”',
    waking: 'READY',
    listening: 'AWAITING INSTRUCTION',
    thinking: 'WORKING',
    tooling: 'ACCESSING DATABANKS',
    speaking: 'RESPONDING',
  },
  systemsTitle: 'SHIP SYSTEMS',
  signalTitle: 'COMM CHANNEL',
  toolKicker: 'accessing',
  ignitionWord: 'ENGAGE',
  ignitionSub: 'bring the main computer online',
  voiceSetTail: '',
  audioTest: 'Audio systems are functioning within normal parameters.',
}

const COPIES: Record<Theme, Copy> = {
  stark: STARK,
  hal: HAL,
  wopr: WOPR,
  mother: MOTHER,
  lcars: LCARS,
}

export const copy = COPIES[THEME]

const PHASE_COLORS: Record<Theme, Record<Phase, string>> = {
  stark: {
        offline: '#0d4a4a',
        boot: '#17b3b3',
        dormant: '#12908f',
        waking: '#5cf2ef',
        listening: '#19d8d2',
        thinking: '#f0a93c',
        tooling: '#a97bff',
        speaking: '#3ef2a8',
      },
  hal: {
    offline: '#3a0606', boot: '#ff2a1f', dormant: '#c9130d', waking: '#ff665c',
    listening: '#ff3b30', thinking: '#ffb000', tooling: '#ff6a00', speaking: '#ffebe8',
  },
  wopr: {
    offline: '#402900', boot: '#ffb000', dormant: '#d18d00', waking: '#ffd166',
    listening: '#ffcb47', thinking: '#ff6b35', tooling: '#ff8c1a', speaking: '#ffe3a3',
  },
  mother: {
    offline: '#18351c', boot: '#8bbf5a', dormant: '#6f9f46', waking: '#b7db7a',
    listening: '#9bcf67', thinking: '#e0b84f', tooling: '#d8863b', speaking: '#d8efae',
  },
  lcars: {
    offline: '#232c48', boot: '#7a8cff', dormant: '#6677e6', waking: '#99ccff',
    listening: '#99ccff', thinking: '#ffaa00', tooling: '#ffaa88', speaking: '#d4e6ff',
  },
}

export const themePhaseColor = PHASE_COLORS[THEME]

/** The resting colours the 3D scene starts from before any phase tint lands. */
export const sceneTint: Record<'core' | 'hot' | 'particles', string> = {
  stark: { core: '#19c4c4', hot: '#c9fdff', particles: '#00e5ff' },
  hal: { core: '#d81912', hot: '#fff5e8', particles: '#ff3b30' },
  wopr: { core: '#d68b00', hot: '#fff0bd', particles: '#ffb000' },
  mother: { core: '#77a94c', hot: '#e4f4bc', particles: '#a7cf69' },
  lcars: { core: '#6677e6', hot: '#e6efff', particles: '#99ccff' },
}[THEME]

export const NAME_PATTERN: string = {
  stark: "(?:jarvis|jarvys|jervis|travis|jarviss|java's|jarv)",
  hal: '(?:(?:hal|hall)(?:\\s+(?:nine\\s+thousand|9000))?)',
  wopr: '(?:joshua|josher|josh|wopr|whopper|warper|w[\\s./-]*o[\\s./-]*p[\\s./-]*r|war\\s+operation\\s+plan\\s+response)',
  mother: '(?:(?:mother|mutter|m[\\s./-]*u[\\s./-]*t[\\s./-]*h[\\s./-]*u[\\s./-]*r)(?:\\s+(?:six\\s+thousand|6000))?)',
  lcars: '(?:computer|computa|compute her)',
}[THEME]

/** Spoken forms supplied to browsers that support contextual phrase biasing. */
export const WAKE_PHRASES: readonly string[] = {
  stark: ['Jarvis', 'Hey Jarvis'],
  hal: ['Hal', 'Hal 9000'],
  wopr: ['Joshua', 'WOPR', 'W O P R', 'War Operation Plan Response'],
  mother: ['Mother', 'MU TH UR', 'MU TH UR 6000'],
  lcars: ['Computer'],
}[THEME]

export const SPEECH_LANGUAGE = 'en-GB'

export const IS_STARK = THEME === 'stark'
