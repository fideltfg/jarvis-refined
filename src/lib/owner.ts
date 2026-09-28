import { startVad, type Vad } from './vad'
import { getProfile, verify } from './speaker'

/**
 * Who is in the room, on the engine that cannot tell you.
 *
 * The browser's SpeechRecognition captures internally and hands back nothing
 * but text. That single fact used to disable the entire speaker gate on the
 * keyless path: an owner who had enrolled a voiceprint was told it was
 * `unavailable`, and in practice the assistant answered anyone — including
 * itself, since his own playback comes back through the microphone as a
 * transcript like everybody else's. The text-level echo filter is the only
 * defence there, and a filter that works on words is exactly as good as the
 * transcription of those words, which for his own voice coming out of a laptop
 * speaker is frequently very bad.
 *
 * So this runs a second, silent pipeline alongside the recogniser: the same
 * energy gate and the same segment capture used by the premium path, feeding
 * the same voiceprint, but discarding the audio afterwards and keeping only the
 * verdict. It never transcribes anything and never speaks to the network. It
 * answers exactly one question, with a timestamp attached — was that the owner?
 *
 * Both problems the owner reported fall out of it. His own voice is not the
 * owner's voice, so a segment of his playback is rejected on acoustics rather
 * than on a mangled transcript, and he stops interrupting himself. A stranger
 * is rejected the same way, so he only listens to the one person.
 *
 * The microphone is shared (see audio.ts), so this costs one more MediaRecorder
 * and roughly a hundred milliseconds of local compute per segment. Nothing
 * leaves the machine.
 */

export type OwnerVerdict =
  /** Measured, and it matched the enrolled voiceprint. */
  | 'owner'
  /** Measured, and it did not. Another person, or his own speakers. */
  | 'stranger'
  /** Nothing could be measured in time — too short, model not ready, silence. */
  | 'unknown'

export type OwnerGate = {
  live: () => boolean
  /**
   * Who was speaking during the utterance that began at `from`?
   *
   * Resolves as soon as a segment covering that moment has been judged, and
   * `unknown` if none has by `timeoutMs`. `slack` loosens the threshold, and is
   * used only for barge-in: a segment recorded while he is talking contains his
   * playback mixed with the owner's voice, which scores lower than the owner
   * alone, and refusing to be interrupted is a worse failure than occasionally
   * stopping for a loud stranger.
   */
  judge: (from: number, timeoutMs: number, slack?: number) => Promise<OwnerVerdict>
  stop: () => void
}

/** Judgements kept. Only the last few seconds are ever consulted. */
const KEEP = 16

/**
 * How far before the words a segment may have ended and still count as theirs.
 *
 * The recogniser reports a transcript some way behind the audio, and the energy
 * gate closes a segment after its own silence window, so the two clocks are
 * never aligned. Generous enough to cover that lag, short enough that a
 * sentence from a minute ago cannot vouch for this one.
 */
const LAG_MS = 2500

type Judged = {
  from: number
  to: number
  score: number
  ok: boolean
  /** False when `verify` waved the segment through without measuring it — too
   *  short, or the model was not loaded. Those must not count as proof. */
  measured: boolean
}

type Waiter = {
  from: number
  slack: number
  settle: (v: OwnerVerdict) => void
}

export const diag = {
  /** Whether the parallel capture is running. */
  live: false,
  /** Segments judged since load. */
  judged: 0,
  /** ...of which matched the owner. */
  owner: 0,
  /** ...and did not. His own playback shows up here, which is the point. */
  stranger: 0,
  /** Segments captured but not yet judged. */
  inFlight: 0,
  /** Verdicts asked for that timed out with nothing measured. */
  unknown: 0,
  /** The most recent score, for tuning the threshold against. */
  lastScore: 0,
  lastError: '',
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__owner = diag
}

/**
 * Start the gate. Resolves to null when there is nothing to check against (no
 * profile) or the microphone cannot be captured a second time — in both cases
 * the caller carries on with the text-level defences it had before.
 */
export async function startOwnerGate(): Promise<OwnerGate | null> {
  const profile = getProfile()
  if (!profile) return null

  const judged: Judged[] = []
  const waiters: Waiter[] = []
  let inFlight = 0
  let capturing = false
  let vad: Vad | null = null
  let stopped = false

  const threshold = () => getProfile()?.threshold ?? 1

  /**
   * What the record says about the moment `from`, or null if it says nothing.
   *
   * Newest first, and one confirmed match anywhere in the window is enough: a
   * person who is interrupted by a cough produces two segments, and the cough
   * must not be able to overrule the sentence.
   */
  const look = (from: number, slack: number): OwnerVerdict | null => {
    let denied = false
    for (let i = judged.length - 1; i >= 0; i--) {
      const w = judged[i]
      if (w.to < from - LAG_MS) break
      if (!w.measured) continue
      if (w.ok || (slack > 0 && w.score >= threshold() - slack)) return 'owner'
      denied = true
    }
    return denied ? 'stranger' : null
  }

  /** Nothing more is coming that could change a 'stranger' into an 'owner'. */
  const quiet = () => inFlight === 0 && !capturing

  const wake = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]
      const v = look(w.from, w.slack)
      if (v === 'owner' || (v === 'stranger' && quiet())) {
        waiters.splice(i, 1)
        w.settle(v)
      }
    }
  }

  const judgeSegment = async (blob: Blob, ms: number) => {
    const to = Date.now()
    const from = to - (ms || 0)
    try {
      const v = await verify(blob, ms)
      // `verify` fails open by design — no model, or a segment too short to
      // place — and returns a zero score when it does. Recording that as a
      // match would hand his own half-second of playback a clean bill of
      // health, which is the exact failure this file exists to stop.
      const measured = v.score > 0
      judged.push({ from, to, score: v.score, ok: v.ok, measured })
      if (judged.length > KEEP) judged.shift()
      if (measured) {
        diag.judged++
        diag.lastScore = Number(v.score.toFixed(4))
        if (v.ok) diag.owner++
        else diag.stranger++
      }
    } catch (err) {
      diag.lastError = String(err)
    } finally {
      inFlight--
      diag.inFlight = inFlight
      wake()
    }
  }

  try {
    vad = await startVad({
      onStart: () => {
        capturing = true
      },
      onEnd: (blob, ms) => {
        capturing = false
        if (stopped) return
        inFlight++
        diag.inFlight = inFlight
        void judgeSegment(blob, ms)
      },
      // The recogniser owns the caption and the level meter; this pipeline is
      // silent by design and reports nothing to the interface.
      onLevel: () => {},
      onError: (message) => {
        diag.lastError = message
        diag.live = false
      },
    })
  } catch (err) {
    diag.lastError = String(err)
    return null
  }

  if (!vad.live()) return null
  diag.live = true

  return {
    live: () => !stopped && (vad?.live() ?? false),
    judge(from, timeoutMs, slack = 0) {
      const now = look(from, slack)
      if (now === 'owner') return Promise.resolve<OwnerVerdict>('owner')
      if (now === 'stranger' && quiet()) return Promise.resolve<OwnerVerdict>('stranger')
      return new Promise<OwnerVerdict>((resolve) => {
        let done = false
        const settle = (v: OwnerVerdict) => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (v === 'unknown') diag.unknown++
          resolve(v)
        }
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.settle === settle)
          if (i >= 0) waiters.splice(i, 1)
          settle(look(from, slack) ?? 'unknown')
        }, timeoutMs)
        waiters.push({ from, slack, settle })
      })
    },
    stop() {
      stopped = true
      diag.live = false
      vad?.stop()
      // Anything still waiting is owed an answer, or the caller hangs.
      while (waiters.length) waiters.pop()!.settle('unknown')
    },
  }
}
