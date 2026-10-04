import { BRIDGE_HTTP_URL } from '../config'
import { getMic, setMicMuted } from './audio'
import { speakingNow, speakingSince } from './tts'
import { OVERRIDE, cutsThrough, isEcho } from './echo'
import { startVad, type Vad } from './vad'
import { caps } from './capabilities'
import { getProfile, verify, warmSpeaker, diag as speakerDiag } from './speaker'
import { startOwnerGate, type OwnerGate } from './owner'
import { NAME_PATTERN, SPEECH_LANGUAGE, WAKE_PHRASES } from '../theme'

/**
 * The voice loop.
 *
 * One recogniser, running for the life of the page. It is never torn down for
 * a turn, and that single fact is most of what separates this from a kiosk:
 * the microphone is still open while JARVIS is talking, so you can cut him off
 * the way you would cut off a person.
 *
 * The obvious design — one recogniser hunting for the wake word, a second one
 * capturing the command, stopping the first to start the second because the
 * browser only hands out one at a time — is what this replaces. It works, but
 * nothing is listening during an answer, so barge-in is impossible, and every
 * restart leaves a quarter-second of deafness that eats whole wake words.
 *
 * Keeping the mic open costs one thing: JARVIS hears himself through the
 * speakers. That is handled here in text rather than in acoustics — see
 * `isEcho` — because the browser gives SpeechRecognition its own capture and
 * won't let us put a canceller in front of it.
 */

export type VoiceMode =
  /** Powered down. Only his name matters. */
  | 'wake'
  /** He is expecting you to speak. Everything is a command. */
  | 'command'
  /** He is thinking or talking. Anything you say is an interruption. */
  | 'guard'
  /** Something is playing that must not be transcribed at all. */
  | 'deaf'

export type VoiceHandlers = {
  /** Read fresh on every result, so the app never has to re-subscribe. */
  mode: () => VoiceMode
  /** Fired on his name, from a partial — waiting for endpointing feels slow.
   *  `trailing` is whatever followed it, so "Jarvis, what's the weather" is
   *  one breath rather than two turns. */
  onWake: (trailing: string) => void
  /** The user has genuinely started talking. This is the barge-in trigger. */
  onSpeechStart: () => void
  /**
   * Something crossed the energy gate while he was talking, and it is not yet
   * known what. Provisional: quieten him, abandon nothing. Exactly one of
   * `onSpeechStart` or `onSpeechResume` always follows.
   */
  onSpeechMaybe: () => void
  /** That noise was not the owner speaking — his own playback, or someone
   *  else in the room. Bring him back up and carry on. */
  onSpeechResume: () => void
  /** Live transcript, for the caption under the reactor. */
  onPartial: (text: string) => void
  /** A complete, endpointed utterance. */
  onUtterance: (text: string) => void
  /** The recogniser is unusable. Distinct from the user saying nothing. */
  onError: (message: string) => void
}

export type Voice = {
  stop: () => void
  /** True while a recogniser is actually running. */
  live: () => boolean
  /** Only hear what is said while `hold(true)` is in effect. */
  setPushToTalk: (on: boolean) => void
  /** The push-to-talk key went down (true) or up (false). */
  hold: (down: boolean) => void
}

export type VoiceOptions = {
  pushToTalk?: boolean
  liveTranscription?: boolean
}

const NO_VOICE: Voice = {
  stop: () => {},
  live: () => false,
  setPushToTalk: () => {},
  hold: () => {},
}

// ---------------------------------------------------------------------------
// Endpointing
// ---------------------------------------------------------------------------

/** One utterance often produces several partials containing his name. */
const WAKE_DEBOUNCE = 1500

/**
 * His name, and the only wake phrase.
 *
 * The optional prefix is genuinely optional: addressing him by name alone is
 * correct, and during an answer "Jarvis" on its own is the natural way to cut
 * in. The negative lookahead keeps possessives ("Jarvis's job") from waking him.
 *
 * The alternates are not padding. "Jarvis" is not in a general dictation
 * model's high-frequency vocabulary, and Chrome routinely returns Travis,
 * Jervis, Jarvys or Java's for a perfectly clear utterance — every one of which
 * used to be silently discarded, so the wake word "just didn't work" with no
 * indication why. Better a rare false wake than a name that does not answer.
 */
const WAKE = new RegExp(
  `\\b(?:hey|hi|ok|okay|yo)?\\s*${NAME_PATTERN}\\b(?!'s)`,
  'i',
)

/** Everything after the wake phrase, which is usually the actual command. */
function afterWake(text: string): string {
  const m = WAKE.exec(text)
  if (!m) return ''
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

/** Short wake names are often normalized into common words by a general STT
 *  model. Correct only an isolated dormant utterance, never a real command. */
function normalizeWake(text: string): string {
  if (WAKE_PHRASES[0] === 'Hal' && /^how[\s,.!?]*$/i.test(text)) return 'Hal'
  return text
}

// ---------------------------------------------------------------------------
// Assembling one utterance out of several segments
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The voice-activity detector is an energy gate, and energy is a fact about the
 * room rather than about the sentence. It ends a segment after a fixed quiet
 * gap, so "what's the weather in — " *pause* " — London" is two segments, two
 * transcripts and, before this, two turns: the first one asking the model a
 * truncated question, the second arriving as a bare noun with no question left
 * to attach it to. People pause. They pause to think of the word, to look at
 * something, mid-list, before the important part. An assistant that treats the
 * first gap as the end of the thought is one you have to talk to carefully, and
 * having to talk carefully is the whole failure.
 *
 * So the segment is no longer the turn. Transcripts accumulate here, and the
 * turn fires only when the text looks finished AND the room has gone quiet.
 *
 * Crucially this costs nothing in the common case. A complete sentence with no
 * one speaking fires immediately — `holdFor` returns 0 — so the latency of an
 * ordinary question is exactly what it was. The waiting only happens when there
 * is a reason to wait.
 */

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Function words only: they are closed-class, so the list is complete in
 * a way a content-word list could never be, and none of them is a plausible
 * last word of a real request.
 */
const CONTINUES =
  /\b(and|or|but|so|because|since|if|when|while|that|which|who|whose|to|of|in|on|at|by|for|with|from|about|into|onto|over|under|between|through|the|a|an|my|your|his|her|its|our|their|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|shall|might|must|like|than|then|as|very|really|just|some|any|all|both|either|neither)$/i

/** Trailing punctuation a transcriber emits mid-thought. */
const TRAILS = /[,;:–—-]$/

/**
 * A barge-in this soon after he starts a sentence is him, not you.
 *
 * Echo cancellation and the raised guard threshold stop most of his playback
 * reaching the detector, but the attack of the very first syllable is the
 * loudest, least-cancelled thing in the whole answer — it arrives before the
 * canceller has adapted to it. Without this, a long answer could interrupt
 * itself on its own first word, which reads as JARVIS refusing to speak.
 *
 * Kept short deliberately. This is the one window where a genuine interruption
 * is also least likely: the user has not yet heard enough to want to stop him.
 */
const SELF_GUARD_MS = 650

/**
 * How long a provisional barge-in may stay unjudged before he comes back up.
 *
 * The verdict needs the segment to end, a transcript to come back from Scribe
 * and an embedding to finish, so it cannot be instant. This is the ceiling: if
 * none of that has arrived by now, assume the noise was not the owner and
 * restore him rather than leaving him whispering for the rest of the answer.
 *
 * Generous on purpose. Settling early is the worse failure — it un-ducks him
 * into the middle of a real interruption, and the owner then has to say it
 * twice.
 */
const BARGE_DECIDE_MS = 4000

/**
 * How far below the threshold a barge-in may score and still be taken as the
 * owner.
 *
 * A segment recorded while he is talking is never a clean sample of anybody: it
 * is the owner's voice plus his own playback, arriving at the microphone
 * together, and the mixture scores lower than the owner alone. Judging an
 * interruption at the full threshold therefore fails in the worst possible
 * direction — an assistant that cannot be interrupted by the one person
 * entitled to interrupt it. The slack is small enough that a genuinely
 * different voice still does not clear it.
 */
const BARGE_SLACK = 0.08

/**
 * How long a finished utterance waits for the voiceprint before being acted on.
 *
 * Only reached when the segment is still being embedded as the words arrive,
 * which is the common case by a fraction of a second. Past this it is treated
 * as unmeasured and accepted — see `take`.
 */
const OWNER_WAIT_MS = 2500

/**
 * A quiet gap this long with a finished-looking sentence ends the turn.
 *
 * Small on purpose: by the time a transcript reaches the assembler the detector
 * has already sat through SILENCE_MS of quiet and the transcriber has taken its
 * own few hundred milliseconds, so roughly a second of real silence has passed
 * already. All this window has to catch is someone drawing breath to add one
 * more clause. Making it generous here is what would make every ordinary
 * question feel slow.
 */
const SETTLE_MS = 450
/** ...and this long when the sentence is plainly unfinished. */
const CONTINUE_MS = 2200
/**
 * Nothing is held longer than this in total. A ceiling rather than a timer:
 * without it, someone who ends every clause on "and" could hold a turn open
 * for ever, and the assistant would look like it had stopped listening.
 */
const MAX_HOLD_MS = 6000

/**
 * How long to keep waiting, given what has been said so far.
 * 0 means "this is a complete thought, send it now".
 */
function holdFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return CONTINUE_MS
  // An explicit terminator is the speaker telling us they are done.
  if (/[.!?]$/.test(text)) return 0
  if (TRAILS.test(text.trim())) return CONTINUE_MS
  if (CONTINUES.test(words[words.length - 1])) return CONTINUE_MS
  // One or two words is usually the start of something, not the whole of it —
  // except for the short commands that genuinely are complete.
  if (words.length <= 2 && !OVERRIDE.test(text)) return CONTINUE_MS
  return SETTLE_MS
}

type Assembler = {
  /** Add a transcript. `active` is true if the user is audibly still going. */
  feed: (text: string, active: boolean) => void
  /** Send whatever is held right now, if anything. */
  flush: () => void
  /** Throw away whatever is held — used when he stands down. */
  cancel: () => void
  held: () => string
}

function makeAssembler(h: {
  emit: (text: string) => void
  partial: (text: string) => void
}): Assembler {
  let held = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const fire = () => {
    clear()
    const text = held.trim()
    held = ''
    firstAt = 0
    if (text) h.emit(text)
  }

  return {
    feed(text, active) {
      if (!text.trim()) return
      held = `${held} ${text}`.replace(/\s+/g, ' ').trim()
      if (!firstAt) firstAt = Date.now()
      // The caption shows the whole thought as it assembles, not just the
      // fragment that happened to arrive last.
      h.partial(held)
      diag.holding = held
      clear()

      // Already talking again. Decide nothing now — the next transcript is
      // part of this same sentence and will bring more of it.
      if (active) {
        timer = setTimeout(fire, MAX_HOLD_MS)
        return
      }

      const wait = Math.min(
        holdFor(held),
        Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)),
      )
      diag.waitedMs = wait
      if (wait === 0) {
        fire()
        return
      }
      timer = setTimeout(fire, wait)
    },
    flush: fire,
    cancel() {
      clear()
      held = ''
      firstAt = 0
      diag.holding = ''
    },
    held: () => held,
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Live state of the voice loop, published on `window.__voice`.
 *
 * When someone says the wake word and nothing happens there are only a handful
 * of possible causes — the recogniser never started, it started and died, it is
 * running but hearing silence, or it is hearing you and transcribing the name
 * as something else. From outside the page those are indistinguishable, which
 * makes the failure impossible to report and impossible to fix. This tells them
 * apart in one glance.
 */
export const diag = {
  /** Which input engine is running: server transcription or browser speech. */
  engine: 'browser',
  /** Whether the microphone pipeline is live. */
  running: false,
  /** Speech segments captured since load. */
  sessions: 0,
  /** The most recent transcript, whatever the mode. */
  heard: '',
  heardAt: 0,
  /** Last failure — a transcription error, or a capture error. */
  lastError: '',
  /** Times the wake word matched. */
  wakes: 0,
  /** Theme-specific names the recogniser is expected to preserve. */
  wakePhrases: [...WAKE_PHRASES],
  /** Exact matcher used after transcription. */
  wakePattern: WAKE.source,
  /** Recognition locale, kept independent from the output voice. */
  language: SPEECH_LANGUAGE,
  /** Current mode, as the app last reported it. */
  mode: '',
  /** Why the last transcript was ignored — '' when it was accepted. */
  dropped: '',
  /** Transcripts accepted and passed to the app. */
  accepted: 0,
  /** Text assembled but not yet sent, because the thought looks unfinished. */
  holding: '',
  /** How long the assembler decided to wait before sending, in ms. */
  waitedMs: 0,
  /** Barge-ins suppressed because he had only just started the sentence. */
  selfGuarded: 0,
  /** Transcription failures (network, or the bridge speech proxy). */
  restarts: 0,
  /** Milliseconds the last transcription round-trip took. */
  idleMs: 0,
  /** Segments discarded because the voice was not the enrolled owner's. */
  strangers: 0,
  /** Whether speaker verification can run on the engine in use. See
   *  `speakerGate` — the browser fallback hands back words with no audio,
   *  so there is nothing to measure and the gate is necessarily off. */
  gate: 'off' as 'off' | 'on' | 'unavailable',
  /** Push-to-talk: nothing is transcribed unless the key is held. */
  ptt: false,
}

/** Record why a transcript went nowhere. Silence always has a reason; this is
 *  the difference between debugging it and speculating about it. */
function drop(why: string) {
  diag.dropped = why
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voice = diag
}

/**
 * Pick the voice engine and start it.
 *
 * Two engines, chosen by what the bridge reported at boot (see capabilities.ts):
 *   - ElevenLabs available -> local voice-activity detection for instant
 *     barge-in, and ElevenLabs Scribe for the words. The reliable path.
 *   - nothing configured -> the browser's own SpeechRecognition, so a student
 *     with no keys still has a working assistant. Less robust, but free and
 *     zero-setup, and guarded by a heartbeat so its silent death is recovered.
 *
 * The microphone is opened once here so a denied permission is reported loudly
 * rather than surfacing later as an unexplained deafness, whichever engine runs.
 */
export async function startVoice(h: VoiceHandlers, opts: VoiceOptions = {}): Promise<Voice> {
  let ptt = !!opts.pushToTalk
  let stopped = false
  setMicMuted(ptt)
  try {
    await getMic()
  } catch (err) {
    diag.lastError = 'mic'
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return NO_VOICE
  }
  const browserAvailable = Boolean((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition)
  const useServer = caps().stt && !(opts.liveTranscription && browserAvailable)
  diag.engine = useServer ? caps().sttProvider ?? 'browser' : 'browser'

  /**
   * Whether the speaker gate can run at all.
   *
   * It needs the audio. The premium engine captures its own and hands it
   * straight to `verify`; the browser engine captures internally and returns
   * nothing but text, which is why this used to read `unavailable` on the
   * keyless path — an owner who had enrolled a profile and believed the room
   * was filtered was running with no filter at all.
   *
   * It no longer is. The browser path now runs its own capture alongside the
   * recogniser purely to answer "whose voice was that" (see owner.ts), so the
   * voiceprint applies on both engines and the only thing that turns it off is
   * not having enrolled one.
   */
  const enrolled = !!getProfile()
  diag.gate = enrolled ? 'on' : 'off'
  if (enrolled) warmSpeaker()

  diag.ptt = ptt
  const engine = await (useServer ? startServerVoice(h, ptt) : startBrowserVoice(h, ptt))
  return {
    stop: () => {
      stopped = true
      engine.stop()
      setMicMuted(true)
    },
    live: () => engine.live(),
    setPushToTalk: (on) => {
      if (stopped || on === ptt) return
      ptt = on
      setMicMuted(on)
      engine.setPushToTalk(on)
    },
    hold: (down) => {
      if (!ptt || stopped) return
      // Open input before capture starts; finish the recording before muting it.
      if (down) setMicMuted(false)
      engine.hold(down)
      if (!down) setMicMuted(true)
    },
  }
}

/** Local VAD plus transcription through the configured bridge provider. */
async function startServerVoice(h: VoiceHandlers, pushToTalk: boolean): Promise<Voice> {
  let lastWake = 0
  let vad: Vad | null = null
  let ptt = pushToTalk

  /**
   * Segments waiting for the transcriber, oldest first.
   *
   * This was a boolean — `if (transcribing) return` — and that single line was
   * the worst bug in the pause story. Segments arrive faster than Scribe
   * answers whenever someone speaks in bursts, which is exactly what pausing
   * mid-sentence looks like, so the second half of the thought was not merely
   * mis-timed, it was silently discarded. Queue instead: nothing a person says
   * out loud gets thrown away because the network was busy.
   *
   * Order is preserved because the drain is single-flight, which matters —
   * "London" arriving before "what's the weather in" is worse than either.
   */
  const pendingAudio: { blob: Blob; ms: number; manual: boolean }[] = []
  let draining = false

  /**
   * A barge-in that has been raised but not yet judged.
   *
   * Energy says someone is talking; only the transcript and the voiceprint can
   * say whether it was the owner. Between those two moments he is ducked and
   * the answer is still alive, and this holds the fact that a decision is owed.
   */
  let bargeAt = 0
  let bargeTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Settle a provisional barge-in, once.
   *
   * `true` cuts the answer for real; `false` brings him back up mid-sentence.
   * Every path out of `transcribe` calls this, including the failures — a
   * segment that could not be transcribed must not leave him whispering for
   * the rest of the answer.
   */
  const settleBarge = (confirmed: boolean) => {
    if (bargeTimer) {
      clearTimeout(bargeTimer)
      bargeTimer = null
    }
    if (!bargeAt) return
    bargeAt = 0
    if (confirmed) h.onSpeechStart()
    else h.onSpeechResume()
  }

  /**
   * Transcripts become turns here rather than one-per-segment.
   * See makeAssembler for why.
   */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  /**
   * Send one captured segment to the bridge and act on the words.
   *
   * The mode is re-read here, not at capture time, because a barge-in flips the
   * machine from 'guard' to 'listening' between the segment starting and its
   * transcript arriving — and the transcript belongs to the mode the user is in
   * now, not the one they interrupted.
   */
  const transcribe = async (blob: Blob, ms: number, manual: boolean) => {
    const mode = h.mode()
    if (mode === 'deaf') return
    const t0 = performance.now()

    /**
     * Who is speaking, worked out at the same time as what they said.
     *
     * Started here rather than awaited here, and that ordering is the whole
     * reason the check is affordable. The embedding takes a hundred-odd
     * milliseconds of local compute and the transcription takes a network
     * round trip; run in sequence they add up, run together the check is free
     * because it finishes long before Scribe answers. Nothing is acted on
     * until both have — see the await below the transcript arrives.
     *
     * Skipped for push-to-talk: holding the key is the proof of ownership.
     */
    const whose = manual ? null : verify(blob, ms)

    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/stt`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      })
      diag.idleMs = Math.round(performance.now() - t0)
      if (!res.ok) {
        diag.restarts++
        diag.lastError = `stt ${res.status}`
        settleBarge(false)
        drop(`transcription failed (${res.status})`)
        return
      }
      const { text } = (await res.json()) as { text?: string }
      const raw = (text ?? '').trim()
      const said = mode === 'wake' && !manual ? normalizeWake(raw) : raw
      diag.lastError = ''

      if (!said) {
        settleBarge(false)
        drop('nothing intelligible in the segment')
        return
      }

      // His own voice, come back through the microphone. The raised guard
      // threshold stops most of it at the door; this catches the rest — and
      // because the barge-in is now provisional, catching it here is enough to
      // stop him interrupting himself rather than merely stopping him acting
      // on what he heard.
      if (isEcho(said, speakingNow())) {
        settleBarge(false)
        drop('echo of his own voice')
        return
      }

      /**
       * Someone else in the room.
       *
       * Checked after the echo test, so his own playback is attributed to the
       * speakers rather than counted as an intruder, and before anything at
       * all is done with the words — no wake, no assembly, no turn, and
       * crucially no transcript surfacing in the caption, because a stranger's
       * sentence appearing on screen and then being ignored is more confusing
       * than silence.
       *
       * `verify` fails open by design, so this is a no-op until the owner has
       * actually enrolled a voiceprint.
       */
      const who = whose ? await whose : { ok: true as const, why: '' }
      if (!who.ok) {
        diag.strangers++
        // A stranger talking over him is not an interruption. Bring him back up
        // and let him finish the sentence he was saying to the owner.
        settleBarge(false)
        drop(who.why)
        return
      }

      // The owner, confirmed by both the words and the voiceprint. Now the
      // answer in flight can be abandoned — this is the only place that is
      // true, and it is why the energy gate above no longer does it.
      settleBarge(true)

      diag.heard = said
      diag.heardAt = Date.now()

      // Releasing the key is the end of the thought; no wake word, no waiting.
      if (manual) {
        assemble.feed(said, true)
        assemble.flush()
        return
      }

      if (mode === 'wake') {
        if (WAKE.test(said) && Date.now() - lastWake > WAKE_DEBOUNCE) {
          lastWake = Date.now()
          diag.wakes++
          diag.dropped = ''
          diag.accepted++
          h.onWake(afterWake(said))
        } else {
          drop(`heard "${said.slice(-40)}" — not his name`)
        }
        return
      }

      // Not a turn yet — a piece of one. The assembler decides when the thought
      // is finished, reading the words and whether the room is still noisy.
      assemble.feed(said, vad?.meter().speaking ?? false)
    } catch (err) {
      diag.restarts++
      diag.lastError = String(err)
      settleBarge(false)
      drop('could not reach the speech service')
    }
  }

  /** One transcription at a time, in the order the segments were spoken. */
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (pendingAudio.length) {
        const next = pendingAudio.shift()!
        await transcribe(next.blob, next.ms, next.manual)
      }
    } finally {
      draining = false
    }
  }

  vad = await startVad({
    onStart: () => {
      const mode = h.mode()
      diag.mode = mode
      diag.sessions++
      if (mode === 'deaf' || ptt) return
      // Standing down mid-thought throws the thought away with it. Otherwise
      // held text would surface as the opening of the *next* conversation.
      if (mode === 'wake') assemble.cancel()
      // The barge-in, raised but NOT acted on.
      //
      // This fires on energy, before a single sample has been embedded, so the
      // thing that crossed the gate may be the owner, may be a stranger, and
      // may be his own playback leaking past the canceller. Cutting the answer
      // here — which is what this used to do — means the loudest event in the
      // room decides whether he gets to finish a sentence, and his own first
      // syllable is routinely the loudest event in the room.
      //
      // So: quieten him and owe a decision. `transcribe` settles it once the
      // words and the voiceprint agree, and every path out of there settles it
      // one way or the other. The user still gets an instant response to
      // speaking over him — he drops to a murmur mid-word — but the answer is
      // only abandoned for the voice that owns him.
      if (mode === 'guard') {
        const since = speakingSince()
        if (since && Date.now() - since < SELF_GUARD_MS) {
          diag.selfGuarded++
          return
        }
        if (!bargeAt) {
          bargeAt = Date.now()
          bargeTimer = setTimeout(() => settleBarge(false), BARGE_DECIDE_MS)
          h.onSpeechMaybe()
        }
      }
    },
    onEnd: (blob, ms) => {
      pendingAudio.push({ blob, ms, manual: ptt })
      void drain()
    },
    onLevel: (v) => {
      // Only paint the live level while actually listening for a command, so a
      // dormant reactor stays calm and does not twitch at every room noise.
      const mode = h.mode()
      if (mode !== 'command') return
      // Never over the assembled text. This used to run unconditionally and
      // overwrote a half-built sentence with an ellipsis sixty times a second,
      // so a pause looked like the interface had forgotten what you just said.
      if (assemble.held()) return
      h.onPartial(v > 0.04 ? '…' : '')
    },
    onError: (message) => {
      diag.lastError = 'capture'
      diag.running = false
      h.onError(message)
    },
  })
  diag.running = vad.live()
  vad.setManual(ptt)

  // Raise the trigger bar exactly while he speaks. The mode is polled rather
  // than pushed because nothing in the app pushes phase changes here, and a
  // 200ms lag on the echo gate is imperceptible.
  const guardPoll = setInterval(() => {
    const mode = h.mode()
    vad?.setGuard(mode === 'guard')
    // He has stood down — by Escape, by the idle timeout, or by dropping back
    // to the wake word. Anything half-said belonged to a conversation that is
    // over, and letting the hold expire later would open the next one with a
    // fragment of the last.
    if ((mode === 'wake' || mode === 'deaf') && assemble.held()) assemble.cancel()
  }, 200)

  return {
    stop: () => {
      clearInterval(guardPoll)
      assemble.cancel()
      vad?.stop()
      diag.running = false
    },
    live: () => vad?.live() ?? false,
    setPushToTalk: (on) => {
      ptt = on
      diag.ptt = on
      assemble.cancel()
      vad?.setManual(on)
    },
    hold: (down) => {
      if (ptt) vad?.hold(down)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Browser fallback: SpeechRecognition                                        */
/* -------------------------------------------------------------------------- */

/**
 * The keyless path. Uses the browser's own SpeechRecognition for both detection
 * and transcription, so a student who has configured nothing still gets voice.
 *
 * It is the flakier engine — Chrome throttles it and it can go silent with no
 * event to catch — so a heartbeat watches it and forces a fresh session
 * whenever it stops showing signs of life. That single guard is the difference
 * between "the wake word stopped working halfway through the lesson" and an
 * assistant that keeps listening.
 */
async function startBrowserVoice(h: VoiceHandlers, pushToTalk: boolean): Promise<Voice> {
  const Ctor =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
  if (!Ctor) {
    h.onError('This browser has no speech recognition — use Chrome or Edge, or add an ElevenLabs key.')
    return NO_VOICE
  }

  /**
   * The voiceprint, on an engine that hands back no audio.
   *
   * A second, silent capture of the same microphone, judging every segment
   * against the enrolled profile and keeping only the verdict. Null when
   * nobody has enrolled, and the text-level defences below then stand alone
   * exactly as they did before.
   */
  const gate: OwnerGate | null = await startOwnerGate().catch(() => null)

  let stopped = false
  let running = false
  let rec: any = null
  /** Push-to-talk: the recogniser only runs while the key is held. */
  let ptt = pushToTalk
  let held = false
  /** Text from an earlier session within the same hold — Chrome can end a
   *  session on its own mid-press, and the words must not be lost. */
  let carry = ''
  let settled = ''
  const finalResults = new Map<number, string>()
  let interim = ''
  let started = false
  let barged = false
  let lastWake = 0
  let lastAlive = Date.now()
  let consumedWakeThrough = -1
  let phraseBias = true
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  /** When the words currently being assembled were first seen. The voiceprint
   *  is asked about that moment, not about now. */
  let speechFrom = 0
  /** A barge-in raised on the words but not yet confirmed by the voice. */
  let bargeAt = 0
  /** A verdict has been reached for this utterance; do not ask twice. */
  let bargeSettled = false
  /** ...and it was the owner, so the answer really was abandoned. */
  let bargeOwner = false

  /**
   * Settle a provisional barge-in, once.
   *
   * `true` abandons the answer; `false` leaves it running and brings him back
   * up. Mirrors the premium path: every route out of a judgement calls this, so
   * he is never left half-interrupted by a noise nobody ever identified.
   */
  const settleBarge = (confirmed: boolean) => {
    if (!bargeAt) return
    bargeAt = 0
    bargeSettled = true
    if (confirmed) {
      bargeOwner = true
      started = true
      barged = true
      h.onSpeechStart()
    } else {
      h.onSpeechResume()
    }
  }

  /** Same assembly rules as the premium path — a pause is not a full stop. */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  const touch = () => {
    lastAlive = Date.now()
  }

  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  const reset = () => {
    clearSilence()
    carry = ''
    settled = ''
    finalResults.clear()
    interim = ''
    started = false
    barged = false
    speechFrom = 0
    bargeSettled = false
    bargeOwner = false
  }

  const emit = () => {
    const text = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    const mode = h.mode()
    const from = speechFrom || Date.now()
    reset()
    if (!text || mode === 'deaf') {
      settleBarge(false)
      return
    }
    if (isEcho(text, speakingNow())) {
      settleBarge(false)
      drop('echo of his own voice')
      return
    }
    void take(text, mode, from)
  }

  /**
   * Act on a finished utterance — but only once the voice that produced it has
   * been placed.
   *
   * This is the second half of the gate. Stopping a stranger from interrupting
   * him is not the same as refusing to obey a stranger, and both are wanted: a
   * sentence that was never the owner's goes no further than this function. No
   * wake word, no assembly, no turn, and nothing in the caption either, because
   * a stranger's words appearing on screen and then being ignored is more
   * confusing than silence.
   *
   * Unknown verdicts are refused whenever the verifier could actually have
   * answered. A loaded model that still cannot place a voice has told us
   * something — the segment was too short, too far from the microphone, or
   * buried under another voice — and acting on it is how the television and the
   * other half of the room get a turn. So the benefit of the doubt survives
   * only while verification is genuinely unavailable: no model, still loading,
   * or failed outright. There the alternative is going deaf, which is worse.
   */
  const take = async (text: string, mode: VoiceMode, from: number) => {
    if (ptt) {
      diag.heard = text
      diag.heardAt = Date.now()
      assemble.feed(text, true)
      assemble.flush()
      return
    }
    if (gate) {
      const who = await gate.judge(from, OWNER_WAIT_MS)
      if (who === 'unknown' && speakerDiag.model === 'ready') {
        diag.strangers++
        settleBarge(false)
        drop('voice not placed as his')
        return
      }
      if (who === 'stranger') {
        diag.strangers++
        // Not the owner, so nothing was interrupted. Whatever he was saying
        // carries on from where it was ducked.
        settleBarge(false)
        drop('another voice in the room')
        return
      }
      // The owner, confirmed acoustically. If the words had already raised a
      // provisional barge-in that has not been settled — the verdict arrived
      // late, or the wait timed out — it is settled now, before the turn.
      if (who === 'owner') settleBarge(true)
    }

    diag.heard = text
    diag.heardAt = Date.now()
    if (mode === 'wake') {
      assemble.cancel()
      if (WAKE.test(text) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        diag.wakes++
        diag.dropped = ''
        diag.accepted++
        h.onWake(afterWake(text))
      } else {
        drop(`heard "${text.slice(-40)}" — not his name`)
      }
      return
    }
    // The recogniser has already endpointed on its own 900ms gap; the assembler
    // decides whether that gap actually ended the thought. `false` because a
    // result only reaches here once the recogniser has gone quiet.
    assemble.feed(text, false)
  }

  const bumpSilence = () => {
    clearSilence()
    // Endpoint on a short quiet gap; the ElevenLabs path tunes this more
    // finely, but a fixed window is plenty for the fallback.
    silenceTimer = setTimeout(emit, 900)
  }

  const onResult = (e: any) => {
    touch()
    const mode = h.mode()
    diag.mode = mode
    if (mode === 'deaf') {
      interim = ''
      return
    }
    let first = e.resultIndex
    if (consumedWakeThrough >= 0) {
      first = Math.max(first, consumedWakeThrough + 1)
      if (first >= e.results.length) return
      consumedWakeThrough = -1
    }
    interim = ''
    for (let i = first; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript as string
      if (e.results[i].isFinal) finalResults.set(i, chunk)
      else interim += chunk
    }
    settled = [
      carry,
      ...[...finalResults.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, text]) => text),
    ]
      .join(' ')
      .trim()
    const rawHeard = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    const heard = mode === 'wake' && !ptt ? normalizeWake(rawHeard) : rawHeard
    if (!heard) return
    if (isEcho(heard, speakingNow())) {
      interim = ''
      return
    }

    if (mode === 'wake' && !ptt) {
      if (WAKE.test(heard) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        const trailing = afterWake(heard)
        const latest = e.results[e.results.length - 1]
        // A bare name often arrives as the first interim result of a longer
        // one-breath command. Wait for finality unless words already follow it.
        if (!trailing && !latest?.isFinal) return
        lastWake = Date.now()
        diag.wakes++
        consumedWakeThrough = e.results.length - 1
        reset()
        h.onWake(trailing)
      } else if (settled.length > 400) {
        settled = ''
      }
      return
    }

    if (!speechFrom) speechFrom = Date.now()
    const full = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    /** True while this utterance is ducked and not yet placed as the owner's. */
    let pending = false
    if (!started || (mode === 'guard' && !barged)) {
      const words = full.split(/\s+/).filter(Boolean).length
      if (mode === 'guard') {
        // An override word cuts through everything below it — "stop" has to
        // work on the first syllable or it is not a stop button.
        // Only a stop word he is not saying himself — see cutsThrough.
        const override = cutsThrough(full, speakingNow())
        if (!override) {
          // His own first syllable, same as the premium path. This engine has
          // no energy gate, so without the clock the only defence is the word
          // count below, and a single clear word is exactly what leaks first.
          const since = speakingSince()
          if (since && Date.now() - since < SELF_GUARD_MS) {
            diag.selfGuarded++
            return
          }
          // Two words before this engine believes an interruption. The energy
          // path can be instant because it triggers on loudness the canceller
          // has already had a pass at; here the evidence is a transcript of
          // audio that includes his own playback, and one word of that is not
          // evidence of anything.
          if (words < 2) return
        }
        /**
         * The words are not allowed to abandon the answer on their own.
         *
         * They are a transcript of a microphone that is currently pointed at a
         * speaker playing his voice, so on this engine "someone said two words"
         * has always been indistinguishable from "he said two words". That is
         * what has been cutting him off inside his own sentences, and no amount
         * of tuning a bag-of-words comparison fixes it, because the input to the
         * comparison is a mis-transcription of his own playback.
         *
         * So the words only raise the question. He drops his voice and waits,
         * the voiceprint answers it from the audio, and the answer is abandoned
         * only for the one person who owns him. Everything else — the
         * television, someone in the doorway, his own speakers — brings him
         * back up mid-sentence with nothing lost.
         */
        if (gate) {
          if (!bargeAt && !bargeSettled) {
            bargeAt = Date.now()
            h.onSpeechMaybe()
            void decideBarge(speechFrom, override)
          }
          // Deliberately not returning. The words still have to be collected
          // and endpointed — if this does turn out to be the owner, the
          // sentence that interrupted him is the sentence he has to answer, and
          // dropping it while the verdict is out would make every interruption
          // need saying twice. Only the caption and the abandonment wait.
          pending = !bargeOwner
        }
      }
      if (!pending) {
        started = true
        if (mode === 'guard') barged = true
        h.onSpeechStart()
      }
    }
    diag.dropped = ''
    // Nothing on screen until the voice is placed. A stranger's sentence
    // appearing in the caption and then being ignored reads as a fault.
    if (!pending) {
      // Show the whole thought, not just the fragment being spoken now — there
      // may be an earlier half of it held by the assembler.
      const carried = assemble.held()
      h.onPartial(carried ? `${carried} ${full}` : full)
    }
    // Push-to-talk ends on release, not on a pause.
    if (!ptt) bumpSilence()
  }

  /**
   * Ask the voiceprint who raised this barge-in, and settle it.
   *
   * `unknown` — nothing measurable, or the model is still loading — resumes,
   * except for an override word. "Stop" has to keep working on a machine where
   * the check cannot run, and a stop that is only honoured for a verified voice
   * is not a stop button.
   */
  const decideBarge = async (from: number, override: boolean) => {
    if (!gate) return
    const who = await gate.judge(from, BARGE_DECIDE_MS, BARGE_SLACK)
    settleBarge(who === 'owner' || (who === 'unknown' && override))
  }

  const spin = () => {
    if (stopped || running || (ptt && !held)) return
    rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = SPEECH_LANGUAGE
    // Chrome's contextual-bias API keeps unusual proper names from being
    // normalized into more common words before our matcher sees them. Older
    // browsers simply lack the constructor and continue without the hint.
    const Phrase = (window as any).SpeechRecognitionPhrase
    if (Phrase && phraseBias && 'phrases' in rec) {
      try {
        rec.phrases = WAKE_PHRASES.map((phrase) => new Phrase(phrase, 10))
      } catch {
        /* contextual bias is optional */
      }
    }
    rec.onstart = () => {
      running = true
      diag.running = true
      diag.lastError = ''
      diag.sessions++
      touch()
    }
    rec.onresult = onResult
    rec.onerror = (ev: any) => {
      diag.lastError = String(ev.error ?? '')
      if (ev.error === 'phrases-not-supported') {
        phraseBias = false
        diag.lastError = ''
        try {
          rec?.abort()
        } catch {
          /* recogniser is already restarting */
        }
        return
      }
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        stopped = true
        diag.running = false
        h.onError('Microphone access was refused — voice input is unavailable.')
      }
    }
    rec.onend = () => {
      running = false
      diag.running = false
      touch()
      rec = null
      if (ptt) {
        if (!held) {
          emit()
          return
        }
        carry = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
        finalResults.clear()
        interim = ''
      }
      if (!stopped) setTimeout(spin, 80)
    }
    try {
      rec.start()
    } catch {
      running = false
      setTimeout(spin, 250)
    }
  }

  spin()

  // The heartbeat. If nothing has been heard from the engine for a while it has
  // gone quiet on us — tear it down and build a fresh one.
  const health = setInterval(() => {
    if (stopped || ptt) return
    const idle = Date.now() - lastAlive
    diag.idleMs = idle
    if (idle < 15000) return
    diag.restarts++
    try {
      rec?.abort()
    } catch {
      /* already gone */
    }
    rec = null
    running = false
    diag.running = false
    touch()
    spin()
  }, 5000)

  return {
    stop: () => {
      stopped = true
      clearInterval(health)
      clearSilence()
      assemble.cancel()
      gate?.stop()
      diag.running = false
      try {
        rec?.abort()
      } catch {
        /* noop */
      }
    },
    live: () => running,
    setPushToTalk: (on) => {
      if (on === ptt) return
      ptt = on
      diag.ptt = on
      held = false
      reset()
      consumedWakeThrough = -1
      assemble.cancel()
      if (on) {
        try {
          rec?.abort()
        } catch {
          /* already gone */
        }
      } else {
        touch()
        spin()
      }
    },
    hold: (down) => {
      if (!ptt || stopped || down === held) return
      held = down
      if (down) {
        touch()
        spin()
        return
      }
      // Released in the gap between two sessions: nothing left to stop.
      if (!rec) {
        emit()
        return
      }
      try {
        rec.stop()
      } catch {
        /* already stopping */
      }
    },
  }
}
