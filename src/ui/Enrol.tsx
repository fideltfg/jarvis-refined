import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { startVad, type Vad } from '../lib/vad'
import {
  ENROL_PHRASES,
  buildProfile,
  clearProfile,
  diag,
  embedSegment,
  getProfile,
} from '../lib/speaker'

/**
 * Teaching JARVIS one voice.
 *
 * The owner reads five short phrases; each one is captured by the same
 * voice-activity detector the assistant uses in ordinary conversation, turned
 * into an embedding, and the set becomes the voiceprint. Everything happens on
 * this machine and the profile is written to localStorage — no audio is
 * uploaded for this, and there is no account anywhere holding a model of
 * someone's voice.
 *
 * Two decisions worth stating.
 *
 * It reuses the real VAD rather than a record button. The point of enrolment
 * is to capture the voice as the system will actually hear it — same
 * microphone, same gate, same room, same segment boundaries. A profile built
 * from carefully-held push-to-talk recordings scores worse against everyday
 * speech than one built this way, which is the opposite of what you would
 * expect and the reason cleaner-looking designs fail here.
 *
 * It reports tightness instead of just declaring success. Five captures of one
 * person in one room cluster; if they do not, something was wrong — a phrase
 * misread, someone else talking over it, a microphone picking up more fan than
 * face — and the profile that results will reject its own owner. That failure
 * surfaces hours later as "JARVIS has stopped listening to me", with no
 * obvious cause, so it is worth catching in the ten seconds where the user is
 * still standing in front of the thing and willing to do it again.
 */

const MIN_SAMPLE_MS = 700

type Stage = 'intro' | 'recording' | 'thinking' | 'done' | 'failed'

export function Enrol() {
  const enrolling = useStore((s) => s.enrolling)
  const setEnrolling = useStore((s) => s.setEnrolling)

  const [stage, setStage] = useState<Stage>('intro')
  const [index, setIndex] = useState(0)
  const [level, setLevel] = useState(0)
  const [note, setNote] = useState('')
  const [tightness, setTightness] = useState(0)

  const vad = useRef<Vad | null>(null)
  const vectors = useRef<Float32Array[]>([])
  /** Guards against a second segment arriving while the first is embedding —
   *  a cough straight after a phrase would otherwise consume the next slot. */
  const busy = useRef(false)

  const stop = () => {
    vad.current?.stop()
    vad.current = null
  }

  useEffect(() => () => stop(), [])

  const begin = async () => {
    vectors.current = []
    setIndex(0)
    setNote('')
    setStage('recording')

    vad.current = await startVad({
      onStart: () => {},
      onLevel: (v) => setLevel(v),
      onError: (message) => {
        setNote(message)
        setStage('failed')
      },
      onEnd: (blob, ms) => {
        if (busy.current) return
        // Too short to be the phrase — a door, a chair, a throat cleared.
        if (ms && ms < MIN_SAMPLE_MS) {
          setNote('That was too brief to use. Say the line again.')
          return
        }
        busy.current = true
        setNote('')
        void (async () => {
          try {
            const vec = await embedSegment(blob)
            if (!vec) {
              // The bare sentence tells nobody why. The loader records the
              // real reason — a blocked download, a missing WASM backend, a
              // rejected fetch — and that is the only thing worth reading.
              setNote(
                diag.lastError
                  ? `The speaker model could not be loaded. ${diag.lastError}`
                  : 'The speaker model could not be loaded.',
              )
              setStage('failed')
              return
            }
            vectors.current.push(vec)
            const next = vectors.current.length
            if (next >= ENROL_PHRASES.length) {
              stop()
              setStage('thinking')
              const built = buildProfile(vectors.current)
              setTightness(built.tightness)
              // A loose cluster means at least one capture was not a clean
              // recording of this person, and saving it would build a profile
              // that rejects them. Better to say so and start again.
              if (built.tightness < 0.72) {
                setNote(
                  'Those five recordings do not sound like the same voice in the same room. Worth doing again somewhere quieter.',
                )
                setStage('failed')
                return
              }
              built.profile.label = 'owner'
              const { saveProfile } = await import('../lib/speaker')
              saveProfile(built.profile)
              setStage('done')
              return
            }
            setIndex(next)
          } finally {
            busy.current = false
          }
        })()
      },
    })
  }

  if (!enrolling) return null

  const existing = getProfile()

  return (
    <div className="enrol-scrim">
      <div className="enrol-card">
        <div className="enrol-title">VOICE PROFILE</div>

        {stage === 'intro' && (
          <>
            <p className="enrol-note">
              {existing
                ? 'A voice is already enrolled. Recording again replaces it.'
                : 'Read five short lines. Everything stays on this machine.'}
            </p>
            <div className="enrol-actions">
              <button className="enrol-btn" onClick={() => void begin()}>
                Begin
              </button>
              {existing && (
                <button
                  className="enrol-btn enrol-btn-quiet"
                  onClick={() => {
                    clearProfile()
                    setEnrolling(false)
                  }}
                >
                  Forget my voice
                </button>
              )}
              <button
                className="enrol-btn enrol-btn-quiet"
                onClick={() => setEnrolling(false)}
              >
                Close
              </button>
            </div>
          </>
        )}

        {stage === 'recording' && (
          <>
            <div className="enrol-count">
              {index + 1} of {ENROL_PHRASES.length}
            </div>
            <p className="enrol-phrase">{ENROL_PHRASES[index]}</p>
            <div className="enrol-bar" style={{ ['--v' as string]: level }} />
            {note && <p className="enrol-warn">{note}</p>}
            <div className="enrol-actions">
              <button
                className="enrol-btn enrol-btn-quiet"
                onClick={() => {
                  stop()
                  setEnrolling(false)
                }}
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {stage === 'thinking' && <p className="enrol-note">Building the profile…</p>}

        {stage === 'done' && (
          <>
            <p className="enrol-note">
              Voice enrolled. Other voices in the room will be heard and ignored.
            </p>
            <p className="enrol-sub">
              Consistency {Math.round(tightness * 100)} percent
            </p>
            <div className="enrol-actions">
              <button className="enrol-btn" onClick={() => setEnrolling(false)}>
                Done
              </button>
            </div>
          </>
        )}

        {stage === 'failed' && (
          <>
            <p className="enrol-warn">{note || 'Enrolment did not complete.'}</p>
            <div className="enrol-actions">
              <button className="enrol-btn" onClick={() => void begin()}>
                Try again
              </button>
              <button
                className="enrol-btn enrol-btn-quiet"
                onClick={() => setEnrolling(false)}
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
