/**
 * Hearing himself.
 *
 * The microphone stays open while he talks — that is what makes barge-in
 * possible — so it hears every word he says. With the browser's own voice and
 * recogniser, echo cancellation cannot help: the OS plays the speech, Chrome
 * never sees it, and so has nothing to cancel against. What is left is to
 * recognise his own words when they come back as a transcript.
 *
 * Kept free of the DOM and of the rest of the voice loop so it can be tested
 * under plain Node (`npm test`).
 */

export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Spelled his way, or the recogniser's.
 *
 * He is written and spoken in British English and every recogniser worth using
 * transcribes to American, so "favourite" leaves the speakers and comes back as
 * "favorite". With ten content words to vote on that costs nothing. With two it
 * is the whole verdict: one spelling mismatch drops the score to a half, under
 * the bar, and he answers his own sentence.
 *
 * Both sides are folded through the same rules, so a rule that is wrong about a
 * word cannot separate that word from itself — the only cost of over-folding is
 * two different words colliding, which takes a whole bag of them to matter.
 */
const IRREGULAR: Record<string, string> = {
  defence: 'defense',
  offence: 'offense',
  pretence: 'pretense',
  licence: 'license',
  practise: 'practice',
  programme: 'program',
  cheque: 'check',
  grey: 'gray',
  tyre: 'tire',
  kerb: 'curb',
  plough: 'plow',
  storey: 'story',
  jewellery: 'jewelry',
  sceptical: 'skeptical',
  moustache: 'mustache',
  pyjamas: 'pajamas',
  aluminium: 'aluminum',
  aeroplane: 'airplane',
  maths: 'math',
  whilst: 'while',
}

export const fold = (w: string) => {
  const known = IRREGULAR[w]
  if (known) return known
  let s = w
  if (s.length > 4) s = s.replace(/our/g, 'or') // colour, favourite, behaviour
  s = s.replace(/isation/g, 'ization').replace(/is(e|ed|es|ing)$/, 'iz$1')
  s = s.replace(/ys(e|ed|es|ing)$/, 'yz$1') // analyse, paralysed
  s = s.replace(/ogue$/, 'og') // catalogue, dialogue
  if (s.length > 4) s = s.replace(/([bcdfgklmnprstvx])re$/, '$1er') // centre, fibre
  s = s.replace(/ll(ed|ing)$/, 'l$1') // travelled, cancelling
  return s
}

const bag = (s: string) => norm(s).split(' ').filter(Boolean).map(fold)

/** Short words that stop him. See `cutsThrough` for when they get to. */
export const OVERRIDE =
  /\b(stop|wait|jarvis|computer|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no)\b/i
const OVERRIDE_ALL = new RegExp(OVERRIDE.source, 'gi')

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('a an the and or but so of to in on at by for with from is are was were be ' +
    'it its this that these those i you he she we they me him her them my your ' +
    'our their what which who how why when where do does did can could would ' +
    'should will shall not no yes if then than as about into over under out up ' +
    'down one two three first second third now here there just very really got ' +
    'get have has had say said tell me okay ok well right').split(' '),
)

/** A stop word this short is a command, whatever he happens to be saying. */
const COMMAND_WORDS = 2

/**
 * Does an override word in this transcript stop him?
 *
 * Suppressing "stop" because he just said "stop" would be the most infuriating
 * failure this file could have — so a short command always wins. But he says
 * "no" constantly, and "wait" and "enough" often enough, and a transcript of
 * his own "No, the render failed" used to walk straight past every echo check
 * on the strength of that one word and cut him off mid-answer. So once the
 * transcript is longer than a command, an override word only counts if it is
 * not one he is saying himself.
 */
export function cutsThrough(heard: string, spoken: string): boolean {
  const said = norm(heard)
  const found = said.match(OVERRIDE_ALL)
  if (!found) return false
  if (!spoken || said.split(' ').length <= COMMAND_WORDS) return true
  const mine = ` ${norm(spoken)} `
  return found.some((w) => !mine.includes(` ${norm(w)} `))
}

/**
 * Is this the microphone hearing the speakers?
 *
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive.
 */
export function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  if (cutsThrough(heard, spoken)) return false

  const all = bag(heard)
  if (!all.length) return true

  const mine = new Set(bag(spoken))
  const content = all.filter((w) => !STOP.has(w))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (all.length < 2) return false
    return all.every((w) => mine.has(w))
  }

  let hits = 0
  for (const w of content) if (mine.has(w)) hits++
  return hits / content.length >= 0.6
}

/**
 * Chrome's recogniser can hand back a transcript a couple of seconds after the
 * audio played, so a sentence keeps arriving at the microphone well after it
 * has finished — and by then he may be two sentences further on.
 */
const ECHO_TAIL_MS = 3000

/**
 * How much of the answer to compare against. Not the whole of it: the longer
 * the reference, the more of the user's own words it happens to contain, and
 * the more likely a real question is thrown away as echo. A few sentences
 * covers the recogniser's lag.
 */
const REFERENCE_CHARS = 600

/** What the microphone is likely to be hearing from the speakers. */
export function createHeard(clock: () => number = Date.now) {
  let current = ''
  let recent = ''
  let until = 0

  return {
    /** A sentence has started playing. */
    say(text: string) {
      const continuing = current !== '' || clock() < until
      recent = continuing ? `${recent} ${text}`.trim() : text
      if (recent.length > REFERENCE_CHARS) {
        const cut = recent.slice(-REFERENCE_CHARS)
        recent = cut.slice(cut.indexOf(' ') + 1)
      }
      current = text
    },
    /** It has stopped — finished or cut off. */
    done() {
      if (current) until = clock() + ECHO_TAIL_MS
      current = ''
    },
    /** The recent answer, or '' once the room has been quiet long enough. */
    now(): string {
      return current !== '' || clock() < until ? recent : ''
    },
  }
}
