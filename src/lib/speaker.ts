/**
 * Speaker verification — who is talking, not what they said.
 *
 * The voice loop has always had one blind spot: a microphone in a room hears
 * the room. Energy gating tells us that *someone* is speaking and the
 * transcriber tells us what words they used, but nothing anywhere in the
 * pipeline has ever asked whether the person speaking is the person this
 * assistant belongs to. In an office, a living room, or anywhere with a
 * television, that is not a theoretical problem — it is the assistant acting
 * on instructions from strangers, and taking a passer-by's sentence as a
 * command is a worse failure than mishearing one.
 *
 * So: a voiceprint. The owner enrols once, speaking a handful of phrases. Each
 * one is turned into a 512-dimension x-vector by a speaker-embedding model
 * running locally in this page, and the set of them is the profile. Every
 * captured segment thereafter gets the same treatment, and its embedding is
 * compared against the profile by cosine similarity. Below the line, the
 * segment is discarded before it reaches the wake word, the assembler, or the
 * model.
 *
 * Three properties this deliberately has:
 *
 *   It is local. The audio never leaves the machine for this purpose, the
 *   profile lives in localStorage, and the model is cached by the browser
 *   after its first download. Voice biometrics are about as personal as data
 *   gets and shipping them to a service would be a poor trade for a check that
 *   runs perfectly well on a laptop.
 *
 *   It fails open. With no profile enrolled, `verify` accepts everything, so
 *   an assistant that has never been trained behaves exactly as it did before
 *   this file existed. A verification system that bricks the product when it
 *   is not configured is worse than no verification.
 *
 *   It fails visibly. Every decision is recorded with its score in `diag`, so
 *   "JARVIS ignored me" is a number you can look at rather than a mood. The
 *   threshold is stored with the profile and can be moved without a rebuild.
 *
 * What it is not: proof of identity. This is a similarity score from a model
 * that has never heard a deliberate impersonation of you specifically, and it
 * is one signal among several — not an authentication boundary. Anything that
 * genuinely must not happen on a stranger's say-so needs a real confirmation
 * step, not a cosine.
 *
 * It also learns. Five phrases read into a laptop on one afternoon describe
 * one version of a voice: that microphone, that distance, that mood, no cold.
 * Every day afterwards is slightly off that, and a fixed profile spends its
 * life getting very slightly worse. So segments that are accepted with room to
 * spare are folded back in — see `adapt` — and the profile tracks the voice
 * instead of a recording of it. The obvious hazard is drift: adapt on a
 * marginal match and the profile walks a little towards whoever produced it,
 * and repeat that enough times and it walks out of the door. Three things stop
 * that. Only comfortable matches are learned from, never borderline ones. The
 * enrolment centroid is frozen as an anchor and nothing may be learned that
 * sits far from it. And enrolment keeps the larger share of the centroid for
 * ever, so no amount of conversation can outvote the five phrases the owner
 * actually sat down and recorded.
 */

// The package's exports map hides dist/, hence the relative path.
import ortMjsUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url'
import ortWasmUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url'

/** Sample rate the embedding model expects. Everything is resampled to this. */
const TARGET_SR = 16000

/**
 * Cosine similarity above which a segment is accepted as the owner.
 *
 * 0.86 is the figure the model's own card uses for verification, and it is a
 * reasonable starting point rather than a tuned one — the right value depends
 * on the microphone, the room and how many phrases were enrolled. It is
 * written into the profile at enrolment so it can be moved per-installation
 * without touching this file.
 */
const DEFAULT_THRESHOLD = 0.86

/**
 * Segments shorter than this are not judged, they are waved through.
 *
 * A half-second of audio does not contain enough voiced speech to place
 * someone reliably, and the model will happily return a confident-looking
 * number for it anyway. Short segments are exactly the ones that matter most —
 * "stop", "Jarvis", "yes" — so the failure mode of judging them is the owner
 * being ignored at the moment they most need to be heard. Let them through and
 * let the words be the filter.
 */
const MIN_MS = 600

// ---------------------------------------------------------------------------
// Adaptation
// ---------------------------------------------------------------------------

/**
 * How far above the threshold a segment must score before the profile will
 * learn from it.
 *
 * This is the whole safety margin of the scheme. A segment that scrapes over
 * the line is exactly the one most likely to be someone else, or the owner
 * plus someone else, or the owner with a television behind him — and learning
 * from it moves the profile towards whatever made the score marginal. Only
 * comfortable matches teach.
 */
const ADAPT_MARGIN = 0.05

/**
 * Segments shorter than this are not learned from even when they match well.
 *
 * `MIN_MS` is the point below which a judgement is unreliable; this is the
 * higher bar for teaching, because a wrong acceptance costs one ignored
 * sentence whereas a wrong lesson is kept for ever.
 */
const ADAPT_MIN_MS = 1200

/** How many learned vectors are kept. A rolling window, oldest evicted, so the
 *  profile follows a voice that changes slowly — a new microphone, a new
 *  room — rather than accumulating everything it has ever heard. */
const ADAPT_MAX = 24

/**
 * Nothing may be learned that sits further than this from the enrolment
 * anchor, whatever it scored against the drifting centroid.
 *
 * Without it, adaptation is a random walk with no fixed point: each step is
 * judged against the profile as it currently stands, so a long series of small
 * legitimate steps can carry it somewhere the owner never was. The anchor is
 * the one thing in the profile that never moves.
 */
const ANCHOR_FLOOR = 0.72

/** Enrolment's share of the centroid. Deliberately more than half — the
 *  recorded phrases are the only samples anyone confirmed were the owner. */
const ENROL_WEIGHT = 0.65

/** Minimum gap between lessons. One long monologue is one voice in one
 *  condition; letting it contribute forty vectors would flush the window and
 *  make the profile a portrait of a single afternoon. */
const ADAPT_GAP_MS = 20000

/** Phrases for the guided enrolment. Varied vowels, varied prosody, no tongue
 *  twisters — the point is a natural voice, not a careful one. */
export const ENROL_PHRASES = [
  'Jarvis, are you there.',
  'Show me the weather for tomorrow morning.',
  'Open the report and read me the first page.',
  'What is on my calendar for the rest of the week.',
  'Thank you, that will be all for now.',
]

export type Voiceprint = {
  version: 2
  /** When the profile was built, so a stale one can be spotted. */
  created: number
  /** One embedding per enrolled phrase. Kept individually rather than only as
   *  a mean: a single bad capture poisons a centroid, but shows up as one
   *  outlier when the vectors are kept apart, and can be dropped. */
  vectors: number[][]
  /** Vectors learned from ordinary conversation since enrolment, newest last.
   *  Capped at `ADAPT_MAX`. Discardable at any time — clearing them returns
   *  the profile to exactly what was enrolled. */
  adapted: number[][]
  /** The enrolment centroid, frozen at enrolment and never rewritten. Every
   *  candidate lesson is checked against this, so the profile can follow the
   *  voice without being able to wander off it. */
  anchor: number[]
  /** The working centroid: enrolment and learned vectors, weighted. */
  centroid: number[]
  threshold: number
  /** Free-text label, so a profile has a name in the diagnostics. */
  label: string
  /** When the profile last learned something, for the diagnostics. */
  adaptedAt: number
}

const STORE_KEY = 'jarvis.voiceprint.v1'

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Published on `window.__speaker`, alongside `window.__voice`.
 *
 * When someone is ignored there are only a few possible reasons — no profile,
 * the model never loaded, the segment was too short to judge, or the score
 * genuinely fell short — and from outside the page they look identical. This
 * tells them apart, and `lastScore` is what you tune the threshold against.
 */
export const diag = {
  /** Whether a profile is enrolled at all. */
  enrolled: false,
  /** Model state: 'idle' | 'loading' | 'ready' | 'failed'. */
  model: 'idle' as 'idle' | 'loading' | 'ready' | 'failed',
  /** Similarity of the most recent judged segment. */
  lastScore: 0,
  /** Whether that segment was accepted. */
  lastMatch: true,
  /** Why the last segment was not judged — '' when it was. */
  lastSkip: '',
  /** Segments accepted as the owner. */
  accepted: 0,
  /** Segments rejected as someone else. */
  rejected: 0,
  /** Milliseconds the last embedding took. */
  ms: 0,
  /** Last failure, if any. */
  lastError: '',
  /** The threshold currently in force. */
  threshold: DEFAULT_THRESHOLD,
  /** How many conversational segments the profile has learned from. */
  adapted: 0,
  /** Similarity of the working centroid to the frozen enrolment anchor. Falls
   *  as the profile tracks the voice; a low figure is the number to look at if
   *  recognition ever starts behaving oddly. */
  drift: 1,
  /** Score of the segment most recently learned from. */
  lastAdapt: 0,
  /** Why the last well-scoring segment was not learned from — '' when it was
   *  or when nothing qualified. */
  lastAdaptSkip: '',
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__speaker = diag
}

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

let profile: Voiceprint | null = null
let profileRead = false

export function getProfile(): Voiceprint | null {
  if (!profileRead) {
    profileRead = true
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (raw) {
        const p = JSON.parse(raw) as Partial<Voiceprint> & { version?: number }
        if (p?.version && Array.isArray(p.centroid) && p.centroid.length) {
          profile = migrate(p)
        }
      }
    } catch (err) {
      diag.lastError = `profile unreadable: ${String(err)}`
    }
  }
  diag.enrolled = !!profile
  diag.threshold = profile?.threshold ?? DEFAULT_THRESHOLD
  diag.adapted = profile?.adapted?.length ?? 0
  diag.drift = profile ? Number(cosine(profile.centroid, profile.anchor).toFixed(4)) : 1
  return profile
}

/**
 * Bring an older stored profile up to the current shape, in memory.
 *
 * A version-1 profile has no anchor because nothing could drift away from it
 * yet, so its centroid becomes the anchor — which is exactly right, since that
 * centroid was built from enrolment and nothing else. The alternative, asking
 * the owner to enrol again because a field was added, throws away the one
 * recording session they actually sat through.
 */
function migrate(p: Partial<Voiceprint> & { version?: number }): Voiceprint {
  const centroid = p.centroid as number[]
  return {
    version: 2,
    created: p.created ?? Date.now(),
    vectors: p.vectors ?? [centroid],
    adapted: p.adapted ?? [],
    anchor: p.anchor ?? centroid,
    centroid,
    threshold: p.threshold ?? DEFAULT_THRESHOLD,
    label: p.label ?? 'owner',
    adaptedAt: p.adaptedAt ?? 0,
  }
}

export function saveProfile(p: Voiceprint): void {
  profile = p
  profileRead = true
  diag.enrolled = true
  diag.threshold = p.threshold
  diag.adapted = p.adapted.length
  diag.drift = Number(cosine(p.centroid, p.anchor).toFixed(4))
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p))
  } catch (err) {
    diag.lastError = `profile unsaveable: ${String(err)}`
  }
}

/** Forget the owner entirely. The assistant reverts to listening to anyone,
 *  which is the correct behaviour for an untrained system. */
export function clearProfile(): void {
  profile = null
  profileRead = true
  diag.enrolled = false
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* nothing to do */
  }
}

/** Move the line without re-enrolling. Exposed for tuning from the console. */
export function setThreshold(t: number): void {
  const p = getProfile()
  if (!p) return
  saveProfile({ ...p, threshold: Math.max(0, Math.min(1, t)) })
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/**
 * Turn a recorded segment into mono 16k float samples.
 *
 * `decodeAudioData` is doing the heavy lifting and is the reason this check
 * can live in the browser at all: it understands the WebM/Opus the recorder
 * produces, so there is no transcode step, no ffmpeg, and no second copy of
 * the audio going anywhere. OfflineAudioContext then handles the resample,
 * which is a genuine resample rather than the sample-dropping that a hand
 * rolled version would be — and the embedding model is sensitive to that,
 * because aliasing looks like a different vocal tract.
 */
async function toSamples(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer()
  const ctx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(bytes)
  } finally {
    void ctx.close()
  }

  if (decoded.sampleRate === TARGET_SR && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0).slice()
  }

  const frames = Math.max(1, Math.round((decoded.duration * TARGET_SR)))
  const off = new OfflineAudioContext(1, frames, TARGET_SR)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const out = await off.startRendering()
  return out.getChannelData(0).slice()
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

type Embedder = (samples: Float32Array) => Promise<Float32Array>

let embedderPromise: Promise<Embedder | null> | null = null

/**
 * Load the speaker-embedding model, once, lazily.
 *
 * Lazily because it is a download, and a user who never enrols should never
 * pay for it. Once because the second call during a busy conversation would
 * otherwise start a second copy — the promise is cached rather than the model
 * so that concurrent callers share the same load rather than racing it.
 *
 * Quantised deliberately. The full-precision weights are several hundred
 * megabytes and the accuracy difference on a one-against-one comparison is far
 * smaller than the difference between a good and a bad microphone.
 */
function loadEmbedder(): Promise<Embedder | null> {
  if (embedderPromise) return embedderPromise
  diag.model = 'loading'
  embedderPromise = (async () => {
    try {
      const { AutoProcessor, AutoModel, env } = await import('@huggingface/transformers')
      // By default the ONNX runtime is fetched from jsdelivr, which the page's
      // CSP (script-src 'self') refuses. Serve the copy shipped in the package.
      const wasm = env.backends.onnx.wasm
      if (wasm) wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl }
      const id = 'Xenova/wavlm-base-plus-sv'
      const processor = await AutoProcessor.from_pretrained(id)
      const model = await AutoModel.from_pretrained(id, { dtype: 'q8' })
      diag.model = 'ready'
      return async (samples: Float32Array) => {
        const inputs = await processor(samples)
        const out = await model(inputs)
        const data = (out.embeddings ?? out.logits).data as Float32Array
        return normalise(Float32Array.from(data))
      }
    } catch (err) {
      diag.model = 'failed'
      diag.lastError = `model: ${String(err)}`
      return null
    }
  })()
  return embedderPromise
}

/**
 * Start the download before it is needed.
 *
 * Called at boot when a profile exists. Without it the first thing the owner
 * says after loading the page waits on a model download, and since `verify`
 * fails open on a model that is not ready yet, that first utterance is also
 * the one segment nobody is checking. Warming it up closes both.
 */
export function warmSpeaker(): void {
  if (!getProfile()) return
  void loadEmbedder()
}

// ---------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------

function normalise(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const n = Math.sqrt(sum) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

/** Both sides are unit vectors, so this is the dot product. */
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot
}

function meanVector(vectors: number[][]): number[] {
  const dim = vectors[0].length
  const out = new Float32Array(dim)
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i]
  for (let i = 0; i < dim; i++) out[i] /= vectors.length
  return Array.from(normalise(out))
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/** One enrolled phrase, ready to be folded into a profile. */
export async function embedSegment(blob: Blob): Promise<Float32Array | null> {
  const embed = await loadEmbedder()
  if (!embed) return null
  const samples = await toSamples(blob)
  return embed(samples)
}

/**
 * Build a profile from captured phrases.
 *
 * The consistency check is the useful part. Five recordings of one person
 * cluster tightly; a set where one sample sits well away from the others means
 * something went wrong in the room — a cough, a second voice, a phrase the
 * user did not actually say — and the honest thing is to report it rather than
 * quietly average it into a centroid that then matches nobody. The caller is
 * expected to show `tightness` and offer to redo it.
 */
export function buildProfile(
  vectors: Float32Array[],
  label = 'owner',
): { profile: Voiceprint; tightness: number; outliers: number[] } {
  const rows = vectors.map((v) => Array.from(v))
  const centroid = meanVector(rows)
  const scores = rows.map((v) => cosine(v, centroid))
  const tightness = scores.reduce((a, b) => a + b, 0) / scores.length
  const outliers = scores
    .map((s, i) => (s < tightness - 0.08 ? i : -1))
    .filter((i) => i >= 0)

  return {
    profile: {
      version: 2,
      created: Date.now(),
      vectors: rows,
      adapted: [],
      anchor: centroid,
      centroid,
      threshold: DEFAULT_THRESHOLD,
      label,
      adaptedAt: 0,
    },
    tightness,
    outliers,
  }
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

/**
 * Recompute the working centroid from enrolment plus what has been learned.
 *
 * Weighted rather than pooled, and that is the point. Pooling would let the
 * learned window outnumber the five enrolled phrases within an afternoon of
 * talking, at which point the confirmed samples are a rounding error and the
 * profile is describing whatever the room has been doing lately. Enrolment
 * keeps `ENROL_WEIGHT` of the result no matter how long the conversation runs.
 */
function blend(p: Voiceprint): number[] {
  if (!p.adapted.length) return meanVector(p.vectors)
  const enrolled = meanVector(p.vectors)
  const learned = meanVector(p.adapted)
  const dim = enrolled.length
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    out[i] = enrolled[i] * ENROL_WEIGHT + learned[i] * (1 - ENROL_WEIGHT)
  }
  return Array.from(normalise(out))
}

let lastAdaptAt = 0

/**
 * Fold a well-matched segment back into the profile.
 *
 * Called only for segments that have already been accepted, and then only when
 * every one of the guards below is satisfied. Each guard exists because of a
 * specific way this goes wrong:
 *
 *   The margin — a borderline accept is the likeliest wrong accept, and
 *   learning from it is how a profile is captured by whoever produced it.
 *
 *   The length — a second of audio teaches more than a third of a second, and
 *   short segments are dominated by whichever phonemes happen to be in them.
 *
 *   The gap — one person talking continuously for a minute would otherwise
 *   fill the entire window with a single set of conditions.
 *
 *   The anchor floor — the only guard that is not about this segment. It is
 *   about the thousandth: each accepted lesson is judged against a centroid
 *   that previous lessons have already moved, so the comparison drifts with
 *   the thing it is meant to check. The anchor does not move.
 *
 * Writing to localStorage on every lesson is fine: this fires at most once
 * every twenty seconds and the payload is a few dozen kilobytes.
 */
function adapt(vec: Float32Array, score: number, ms: number): void {
  const p = getProfile()
  if (!p) return

  if (score < p.threshold + ADAPT_MARGIN) {
    diag.lastAdaptSkip = 'match too close to the line to learn from'
    return
  }
  if (ms && ms < ADAPT_MIN_MS) {
    diag.lastAdaptSkip = 'segment too short to learn from'
    return
  }
  const now = Date.now()
  if (now - lastAdaptAt < ADAPT_GAP_MS) {
    diag.lastAdaptSkip = 'learned from a segment recently'
    return
  }
  const toAnchor = cosine(vec, p.anchor)
  if (toAnchor < ANCHOR_FLOOR) {
    diag.lastAdaptSkip = `too far from enrolment to learn from (${toAnchor.toFixed(2)})`
    return
  }

  lastAdaptAt = now
  const adapted = [...p.adapted, Array.from(vec)].slice(-ADAPT_MAX)
  const next: Voiceprint = { ...p, adapted, adaptedAt: now }
  next.centroid = blend(next)
  saveProfile(next)

  diag.lastAdapt = Number(score.toFixed(4))
  diag.lastAdaptSkip = ''
}

/**
 * Forget everything learned since enrolment, keeping the enrolment itself.
 *
 * The repair for a profile that has been taught something it should not have
 * been — a housemate who talks like you, a fortnight of a bad cold, a
 * microphone that has since been replaced. Cheaper than enrolling again, and
 * it is the first thing to try when recognition starts feeling wrong.
 */
export function resetAdaptation(): void {
  const p = getProfile()
  if (!p) return
  const next: Voiceprint = { ...p, adapted: [], adaptedAt: 0 }
  next.centroid = blend(next)
  saveProfile(next)
  diag.lastAdapt = 0
  diag.lastAdaptSkip = ''
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export type Verdict = {
  /** Whether this segment should be acted on. */
  ok: boolean
  /** Cosine similarity, or 0 when nothing was measured. */
  score: number
  /** Why, in a phrase, for the diagnostics and the drop reason. */
  why: string
}

/**
 * Decide whether a captured segment is the owner speaking.
 *
 * Every path that returns `ok: true` without measuring anything is a
 * deliberate fail-open, and they are all listed here rather than scattered:
 * no profile, model unavailable, segment too short, decode failure. The
 * alternative — refusing to act whenever the check cannot run — turns a
 * transient model download error into an assistant that has stopped
 * responding, with no way for the user to find out why by talking to it.
 *
 * The comparison itself takes the better of two scores: against the centroid,
 * which is the stable summary of the voice, and against the closest single
 * enrolled phrase, which rescues the cases where the owner is speaking in a
 * register the mean has smoothed away — quietly, at distance, first thing in
 * the morning.
 */
export async function verify(blob: Blob, ms: number): Promise<Verdict> {
  const p = getProfile()
  if (!p) return { ok: true, score: 0, why: 'no voiceprint enrolled' }

  if (ms && ms < MIN_MS) {
    diag.lastSkip = 'segment too short to judge'
    return { ok: true, score: 0, why: diag.lastSkip }
  }

  const embed = await loadEmbedder()
  if (!embed) {
    diag.lastSkip = 'speaker model unavailable'
    return { ok: true, score: 0, why: diag.lastSkip }
  }

  const t0 = performance.now()
  let vec: Float32Array
  try {
    vec = await embed(await toSamples(blob))
  } catch (err) {
    diag.lastError = `embed: ${String(err)}`
    diag.lastSkip = 'segment could not be analysed'
    return { ok: true, score: 0, why: diag.lastSkip }
  }
  diag.ms = Math.round(performance.now() - t0)
  diag.lastSkip = ''

  // Centroid first, then the nearest single remembered sample — enrolled or
  // learned. The learned ones are what make this better over time: a centroid
  // describes an average of the owner's voice and the owner is very rarely
  // average, whereas a vector captured last Tuesday at this desk on this
  // microphone matches this desk and this microphone exactly. Every learned
  // vector has already passed the margin and the anchor floor, so treating
  // them as exemplars is no looser than trusting the enrolled ones.
  let best = cosine(vec, p.centroid)
  for (const v of p.vectors) best = Math.max(best, cosine(vec, v))
  for (const v of p.adapted) best = Math.max(best, cosine(vec, v))

  const ok = best >= p.threshold
  diag.lastScore = Number(best.toFixed(4))
  diag.lastMatch = ok
  if (ok) diag.accepted++
  else diag.rejected++

  // Learn from it, if it earned the right to teach. Deliberately after the
  // verdict is fixed, so nothing about this decision depends on it, and the
  // segment being acted on is never waiting on the profile being rewritten.
  if (ok) adapt(vec, best, ms)

  return {
    ok,
    score: best,
    why: ok ? 'owner' : `another voice (${best.toFixed(2)} < ${p.threshold})`,
  }
}
