import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * The `ui_*` tools — JARVIS's control of his own face.
 *
 * `display` gives him a screen to put things on. This gives him the screen
 * itself: the colour the room is lit in, the size and temper of the reactor,
 * what hangs in orbit around it, which furniture is up, and the occasional
 * flourish. The point is not decoration. An interface that goes red before he
 * says a word, or drops every rail so one photograph fills the frame, is
 * carrying meaning faster than speech can — which is the whole reason a voice
 * assistant has a face at all.
 *
 * The descriptions below are the product. They are the only place the model
 * learns what the interface can be made to do and, more importantly, when it is
 * worth doing — so they are written as direction, not as parameter lists.
 *
 * Like panels.mjs this runs in-process, so a handler pushes straight down the
 * open WebSocket. Every handler emits exactly one message, matching the
 * bridge -> browser contract: { type: 'ui', op, args }.
 */

/**
 * Numbers and booleans arrive however the model felt like writing them — '0.5'
 * as a string, 1 for true, null for "leave it". A turn that fails because a
 * scale was quoted is a turn the user watched break, so nothing here rejects:
 * unions accept the loose forms, `.catch()` swallows the rest as absent, and
 * the handlers clamp into the ranges the browser expects. The worst outcome of
 * a bad value is that it is ignored.
 */
const looseNumber = (note) =>
  z.union([z.number(), z.string()]).optional().catch(undefined).describe(note)

const looseBool = (note) =>
  z
    .union([z.boolean(), z.string(), z.number()])
    .optional()
    .catch(undefined)
    .describe(note)

const colour = (note) =>
  z.union([z.string(), z.null()]).optional().catch(undefined).describe(note)

const FALSEY = new Set(['false', '0', 'no', 'off', 'hide', 'hidden', 'none'])

/** Words that mean "stop overriding this and follow the phase again". */
const AUTOMATIC = new Set(['auto', 'default', 'none', 'null', 'reset', 'clear', 'stock'])

function clamp(value, lo, hi) {
  if (value === undefined || value === null) return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) return undefined
  return Math.min(hi, Math.max(lo, n))
}

function toBool(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const s = String(value).trim().toLowerCase()
  if (!s) return undefined
  return !FALSEY.has(s)
}

/** Returns null for "follow the phase", undefined for "not mentioned". */
function toColour(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  const s = String(value).trim()
  if (!s || AUTOMATIC.has(s.toLowerCase())) return null
  return s
}

/** Only real values reach the patch, so a deep merge never clears by accident. */
function put(target, key, value) {
  if (value !== undefined) target[key] = value
  return target
}

const has = (obj) => Object.keys(obj).length > 0

const ok = (text) => ({ content: [{ type: 'text', text }] })

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/**
 * The phase list is the store's `Phase` union, and the notes are what each one
 * means on screen — the model is picking colours for states it never sees, so
 * naming the moment is worth more than naming the constant.
 */
const PHASE_NOTES = {
  offline: 'before the user has unlocked audio',
  boot: 'the startup sequence',
  dormant: 'powered down, waiting for the wake word',
  waking: 'the wake word just landed',
  listening: 'capturing speech',
  thinking: 'you are composing an answer',
  tooling: 'a tool is running',
  speaking: 'you are reading the answer back',
}

const PHASES = Object.keys(PHASE_NOTES)

const themeSchema = {
  accent: colour(
    'One CSS colour that overrides the phase colour everywhere at once — the ' +
      'reactor, the panel borders, the rails, the type. e.g. "#ff2d2d", ' +
      '"crimson", "rgb(20 200 255)". Pass null or "auto" to hand the interface ' +
      'back to its phase colours.',
  ),
  background: colour(
    'The page behind everything. Near-black by default and it must stay dark ' +
      '— a pale background destroys the glow and makes the display unreadable. ' +
      'Nudge it instead: "#080d18" for a colder room, "#150808" under an ' +
      'alert. Pass null or "auto" for the stock near-black.',
  ),
  phase_colors: z
    .object(
      // Built from one list so this can never drift from the store's phases.
      Object.fromEntries(
        PHASES.map((p) => [p, colour(`Colour for ${p} — ${PHASE_NOTES[p]}.`)]),
      ),
    )
    .partial()
    .optional()
    .catch(undefined)
    .describe(
      'Recolour individual states rather than overriding all of them. Use ' +
        'this when one moment deserves its own identity — a red "thinking" ' +
        'while you work through something grim — and the rest of the ' +
        'interface should carry on as normal.',
    ),
}

const THEME_DESCRIPTION = `Retint the whole interface.

The HUD normally follows your state (cyan listening, amber thinking, violet
tooling, green speaking); an accent overrides that everywhere at once.

Use it only when the colour means something — red for a bad result, amber for
waiting. Call \`ui_reset\` when the moment passes. Never announce it.`

const reactorSchema = {
  color: colour(
    'The reactor core on its own, without touching the rest of the interface. ' +
      'Any CSS colour. Pass null or "auto" to follow the accent and phase again.',
  ),
  scale: looseNumber('Size multiplier, 0.2 to 3, default 1. Above 1.5 it owns the frame.'),
  intensity: looseNumber(
    'Glow, 0 to 3, default 1. 0.3 reads as standby, 2 or more as strain.',
  ),
  spin: looseNumber(
    'Rotation rate, 0 to 5, default 1. 0 reads as powered down, 3 and up as effort.',
  ),
  style: z
    .enum(['ring', 'sphere', 'wire'])
    .optional()
    .catch(undefined)
    .describe(
      'ring = stock halo. sphere = solid core, heavier. wire = skeletal ' +
        'lattice, for diagnostics and degraded states.',
    ),
  visible: looseBool(
    'false removes the reactor entirely, for a full-frame image. Put it back after.',
  ),
}

const REACTOR_DESCRIPTION = `Reshape the reactor at the centre of the display.

The reactor is you: its size, brightness and speed read as your state. Dim and
slow is idling; bright and fast is working hard.

Change one property at a time. Everything omitted stays as it is.`

const orbitSchema = {
  action: z
    .enum(['add', 'remove', 'clear'])
    .default('add')
    .catch('add')
    .describe(
      'add = put an image in orbit (replaces the one with the same id). ' +
        'remove = take one down by id. clear = take them all down.',
    ),
  id: z
    .string()
    .optional()
    .catch(undefined)
    .describe(
      'A short name you choose, e.g. "suit", "shot-1". Required to remove; on ' +
        'add it replaces rather than stacks.',
    ),
  src: z
    .string()
    .optional()
    .catch(undefined)
    .describe(
      'Absolute disk path or file:/// URL. http(s) is blocked by the page, so ' +
        'never orbit a picture from the web.',
    ),
  radius: looseNumber(
    'Fraction of the smaller screen axis, 0.1 to 1.2, default 0.55. 0.3 hugs ' +
      'the reactor, 0.8 sweeps past the panels.',
  ),
  speed: looseNumber(
    'RPM, -30 to 30, default 4. Two to six is stately. Negative counter-rotates.',
  ),
  size: looseNumber('Rendered size in pixels, 16 to 400, default 96.'),
  tilt: looseNumber(
    'Orbital-plane tilt in degrees, -80 to 80, default 24. 20 to 50 sells the depth.',
  ),
  opacity: looseNumber('0 to 1, default 0.9. Drop to 0.4 for atmosphere.'),
  phase: looseNumber(
    'Starting angle in degrees. Omitted, objects are spaced automatically.',
  ),
}

const ORBIT_DESCRIPTION = `Hang an image in orbit around the reactor.

For a render you generated or a screenshot you captured — it lives in the room
rather than in a card.

  - Only images you produced. Absolute path or file:/// URL; web URLs refused.
  - Three or four objects at most.
  - Persists until you clear it. Clear it when the subject changes.
  - Orbit it to be felt; use \`display\` when it must be looked at.`

const chromeSchema = {
  systems: looseBool('The SYSTEMS rail down the left — connected servers and status.'),
  transcript: looseBool('The running conversation log.'),
  tool_badge: looseBool('The active-tool readout under the reactor.'),
  suggestions: looseBool('The "try saying…" hint.'),
  brand: looseBool('The J.A.R.V.I.S. wordmark and status line.'),
}

const CHROME_DESCRIPTION = `Show or hide the furniture around the display.

Everything is up by default. Hide it only when the absence helps — one image
being studied, one number to hold — and put it back afterwards, since the user
cannot restore it themselves.

Pass true to show, false to hide. Anything omitted stays as it is.`

const EFFECT_DESCRIPTION = `Fire a one-off effect across the interface.

  glitch = corruption, interference, something wrong with the data itself.
  pulse  = acknowledgement. Something completed, something arrived.
  scan   = a sweep across the display. Searching, analysing, reading.
  shake  = impact, or a hard stop. The strongest thing here; use it once.
  flash  = a sudden alert. Reserve it for something the user must notice now.

At most one per turn, and only when something actually happened. Silence on the
screen is the default.`

const SCREEN_DESCRIPTION = `Clear the display.

  panels     = take down every card, including the sticky ones.
  transcript = wipe the conversation log.
  all        = both.

Use it when the user says clear the screen, or when leftovers from a finished
topic would confuse the next one. Does not touch theme, reactor or orbits —
\`ui_reset\` does that.`

const RESET_DESCRIPTION = `Put the entire interface back to stock.

Colours, reactor, orbits, chrome all return to stock. Panels and the transcript
are left alone. Call it when the user asks for normal, or when whatever
justified a change is over.`

/**
 * Ids arrive in bursts and `Date.now()` alone collides, so a counter carries
 * the uniqueness — the same reasoning as panel ids in panels.mjs.
 *
 * The counter is also what spaces unplaced objects out. Successive orbits step
 * by the golden angle, so two, three or five images never land on top of one
 * another the way a fixed increment eventually does.
 */
let seq = 0

const GOLDEN_ANGLE = 137.507764

/**
 * @param {(op: string, args: object) => void} emit - pushes one ui message
 */
export function uiServer(emit) {
  return createSdkMcpServer({
    name: 'jarvis_ui',
    version: '1.0.0',
    instructions:
      'JARVIS\'s control of his own interface — colour, reactor, orbiting ' +
      'images, chrome, effects. Change it when the change carries meaning, ' +
      'and put it back afterwards with ui_reset.',
    // Same reasoning as the display server: behind tool search it would never
    // occur to the model that the interface is something it can touch.
    alwaysLoad: true,
    tools: [
      tool('ui_theme', THEME_DESCRIPTION, themeSchema, async (args) => {
        const patch = {}
        put(patch, 'accent', toColour(args.accent))
        put(patch, 'background', toColour(args.background))

        const palette = {}
        for (const [phase, value] of Object.entries(args.phase_colors ?? {})) {
          // A phase colour has no "unset" in the contract — it is a string or
          // it is absent — so a null here is dropped rather than written.
          const c = toColour(value)
          if (PHASES.includes(phase) && typeof c === 'string') palette[phase] = c
        }
        if (has(palette)) patch.palette = palette

        if (!has(patch)) return ok('No change — no colours were given.')
        emit('patch', patch)
        return ok('Interface retinted.')
      }),

      tool('ui_reactor', REACTOR_DESCRIPTION, reactorSchema, async (args) => {
        const reactor = {}
        put(reactor, 'color', toColour(args.color))
        put(reactor, 'scale', clamp(args.scale, 0.2, 3))
        put(reactor, 'intensity', clamp(args.intensity, 0, 3))
        put(reactor, 'spin', clamp(args.spin, 0, 5))
        put(reactor, 'style', args.style)
        put(reactor, 'visible', toBool(args.visible))

        if (!has(reactor)) return ok('No change — no reactor properties were given.')
        emit('patch', { reactor })
        return ok('Reactor adjusted.')
      }),

      tool('ui_orbit', ORBIT_DESCRIPTION, orbitSchema, async (args) => {
        const action = args.action ?? 'add'

        if (action === 'clear') {
          emit('orbit', { action: 'clear' })
          return ok('Orbits cleared.')
        }

        if (action === 'remove') {
          const id = String(args.id ?? '').trim()
          // Handed back rather than guessed at: removing "probably the last
          // one" is how an image the user was still looking at disappears.
          if (!id) {
            return refuse(
              'Not removed: remove needs the id the object was added with. ' +
                'Call ui_orbit with action "clear" to take them all down.',
            )
          }
          emit('orbit', { action: 'remove', id })
          return ok('Orbit removed.')
        }

        const src = String(args.src ?? '').trim()
        if (!src) {
          return refuse(
            'Not added: an orbiting object needs a src. Give an absolute disk ' +
              'path or a file:/// URL to an image you generated or captured.',
          )
        }
        // Refused rather than emitted, because the page's CSP drops it silently
        // — the model would believe the image is up and describe something the
        // user cannot see. The one exception is the bridge's own /file endpoint.
        if (/^https?:\/\//i.test(src) && !/^http:\/\/localhost:8787\//i.test(src)) {
          return refuse(
            'Not added: remote images are blocked by the page. Orbit a file on ' +
              'this machine instead — an absolute path or a file:/// URL to ' +
              'something you generated, rendered or captured.',
          )
        }

        const n = seq++
        // Wrapped rather than clamped: 400 degrees is a perfectly sensible
        // thing to mean, and clamping it into a range would silently stack two
        // objects at the same point on the ring.
        const angle = clamp(args.phase, -1e6, 1e6)
        const object = {
          id: String(args.id ?? '').trim() || `o${Date.now().toString(36)}-${n.toString(36)}`,
          src,
          radius: clamp(args.radius, 0.1, 1.2) ?? 0.55,
          speed: clamp(args.speed, -30, 30) ?? 4,
          size: clamp(args.size, 16, 400) ?? 96,
          tilt: clamp(args.tilt, -80, 80) ?? 24,
          opacity: clamp(args.opacity, 0, 1) ?? 0.9,
          phase: angle === undefined ? (n * GOLDEN_ANGLE) % 360 : ((angle % 360) + 360) % 360,
        }
        emit('orbit', { action: 'add', ...object })
        return ok(`In orbit as "${object.id}".`)
      }),

      tool('ui_chrome', CHROME_DESCRIPTION, chromeSchema, async (args) => {
        const chrome = {}
        put(chrome, 'systems', toBool(args.systems))
        put(chrome, 'transcript', toBool(args.transcript))
        // Snake case at the tool boundary, camel case in the store — the model
        // writes the former far more reliably and the store cannot change.
        put(chrome, 'toolBadge', toBool(args.tool_badge))
        put(chrome, 'suggestions', toBool(args.suggestions))
        put(chrome, 'brand', toBool(args.brand))

        if (!has(chrome)) return ok('No change — nothing was named.')
        emit('patch', { chrome })
        return ok('Chrome updated.')
      }),

      tool(
        'ui_effect',
        EFFECT_DESCRIPTION,
        {
          kind: z
            .enum(['glitch', 'pulse', 'scan', 'shake', 'flash'])
            .catch('pulse')
            .describe('Which effect to fire.'),
        },
        async (args) => {
          emit('effect', { kind: args.kind ?? 'pulse' })
          return ok('Fired.')
        },
      ),

      tool(
        'ui_screen',
        SCREEN_DESCRIPTION,
        {
          what: z
            .enum(['all', 'panels', 'transcript'])
            .default('all')
            .catch('all')
            .describe('What to clear.'),
        },
        async (args) => {
          const what = args.what ?? 'all'
          emit('screen', { what })
          return ok('Cleared.')
        },
      ),

      tool('ui_reset', RESET_DESCRIPTION, {}, async () => {
        emit('reset', {})
        return ok('Interface restored.')
      }),
    ],
  })
}
