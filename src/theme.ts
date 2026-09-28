import { THEME } from './config'
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

const LCARS: Copy = {
  title: 'LCARS',
  brand: 'LCARS',
  brandSub: 'Library Computer Access and Retrieval System',
  speaker: 'COMPUTER',
  wakePhrase: 'computer',
  status: {
    offline: 'OFFLINE',
    boot: 'SYSTEMS CHECK',
    dormant: 'STANDING BY — SAY “COMPUTER”',
    waking: 'READY',
    listening: 'RECEIVING',
    thinking: 'WORKING',
    tooling: 'ACCESSING DATABANKS',
    speaking: 'TRANSMITTING',
  },
  systemsTitle: 'SUBSYSTEMS',
  signalTitle: 'AUDIO',
  toolKicker: 'accessing',
  ignitionWord: 'ACTIVATE',
  ignitionSub: 'tap, or clap, to access LCARS',
  voiceSetTail: '',
  audioTest: 'Audio test. Speech output is functional.',
}

export const copy: Copy = THEME === 'lcars' ? LCARS : STARK

/**
 * Colour identity per phase. The LCARS set is the TNG panel palette: orange at
 * rest, blue while it listens, lilac while it thinks, periwinkle while a tool
 * runs — so the state reads from across the room exactly as the cyan set does.
 */
export const themePhaseColor: Record<Phase, string> =
  THEME === 'lcars'
    ? {
        offline: '#5c3a12',
        boot: '#ff9966',
        dormant: '#ff9900',
        waking: '#ffcc66',
        listening: '#99ccff',
        thinking: '#cc99cc',
        tooling: '#9999ff',
        speaking: '#ffcc99',
      }
    : {
        offline: '#0d4a4a',
        boot: '#17b3b3',
        dormant: '#12908f',
        waking: '#5cf2ef',
        listening: '#19d8d2',
        thinking: '#f0a93c',
        tooling: '#a97bff',
        speaking: '#3ef2a8',
      }

/** The resting colours the 3D scene starts from before any phase tint lands. */
export const sceneTint =
  THEME === 'lcars'
    ? { core: '#ff9900', hot: '#fff1dc', particles: '#ffcc99' }
    : { core: '#19c4c4', hot: '#c9fdff', particles: '#00e5ff' }

/**
 * The wake word, and the mishearings of it that count. "Computer" is common
 * dictation vocabulary so it needs far fewer alternates than "Jarvis" does.
 */
export const NAME_PATTERN =
  THEME === 'lcars'
    ? "(?:computer|computers|komputer|compute her)"
    : "(?:jarvis|jarvys|jervis|travis|jarviss|java's|jarv)"

export const IS_LCARS = THEME === 'lcars'
