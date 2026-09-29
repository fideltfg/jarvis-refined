import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { probeUrl } from './page.mjs'

/**
 * The `display` tool — JARVIS's screen.
 *
 * Rather than filling in a fixed set of card templates, the model authors the
 * panel itself: markup, layout, emphasis, and which animation it arrives with.
 * A search result and a phone screenshot and a revenue figure should not look
 * like the same component with different words in it, and only the thing
 * composing the answer knows what the answer wants to look like.
 *
 * What's fixed is the design system below, so everything it builds still looks
 * like one interface. The browser sanitises the markup before it renders.
 *
 * It runs in-process (an SDK MCP server, not a subprocess), so the handler
 * pushes straight down the open WebSocket — no round trip, no temp file.
 */

const DESIGN_SYSTEM = `
CLASSES — use these and nothing else; any other class name is stripped.
  .hud-rows .hud-row   vertical list; a row holds .hud-idx, .hud-main, .hud-tag
  .hud-idx             leading index or glyph, dim and monospaced
  .hud-main            the row's text column, holding .hud-label / .hud-sub
  .hud-label .hud-sub  primary line (clamped to 2) and dimmed secondary line
  .hud-tag             small trailing tag, right-aligned
  .hud-metric .hud-unit  huge numeral with a small caption under it
  .hud-note            a short passage of prose
  .hud-img .hud-caption  full-width <img>, and one line under it
  .hud-grid            two-column grid
  .hud-bar             thin progress bar; set style="--v:0.62" for 62%
  .hud-dim .hud-hot    de-emphasise / emphasise (hot picks up the accent)
  .hud-gallery .hud-thumb  grid of images; one thumbnail
  .hud-video           <video> player, full width
  .hud-embed           16:9 wrapper for an allowed <iframe>
  .hud-figure          image or video grouped with its .hud-caption

IMAGES AND VIDEO work — use them. Remote images are fetched server-side, so
hotlink-blocking hosts still render; local files go in as file:///path. Paste
URLs exactly as a tool result gave them and never invent one. If a search
returned pictures, the gallery IS the answer. YouTube/Vimeo go in an <iframe>
inside .hud-embed; .mp4/.webm in <video class="hud-video" controls>.

CONTENT: fetch the page (exa crawl/fetch, or the browser) and render its
substance in these classes — headline, the two or three lines that matter, the
figure, the photograph. Never put a bare source URL on screen for the page to
resolve itself; that renders as an empty rectangle.

RULES
  - No inline colours; the 'accent' argument themes the classes for you.
  - No <style>, <script>, <form> or event handlers — stripped.
  - <iframe> only for www.youtube-nocookie.com/embed, www.youtube.com/embed and
    player.vimeo.com/video. A watch?v=ID or youtu.be/ID link is rewritten for you.
  - Every panel needs visible text or a working image; an empty body is rejected.
  - Roughly 6 rows or 40 words. Four thumbnails, six at the outside. One video.

EXAMPLES
<div class="hud-rows">
  <div class="hud-row"><span class="hud-idx">01</span><span class="hud-main"><span class="hud-label">Anthropic ships Claude Opus 5</span><span class="hud-sub">A step change on agentic coding</span></span><span class="hud-tag">reuters</span></div>
</div>
<div><span class="hud-metric">1,284</span><span class="hud-unit">unread since monday</span></div>
<div class="hud-figure"><div class="hud-gallery"><img class="hud-thumb" src="https://images.example.com/sr71-01.jpg"><img class="hud-thumb" src="https://cdn.example.org/takeoff.jpg"></div><span class="hud-caption">SR-71 · four of two hundred results</span></div>
<div class="hud-figure"><div class="hud-embed"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="Flight 11" allowfullscreen></iframe></div><span class="hud-caption">SpaceX · 4:32</span></div>
<p class="hud-note">Three of four services nominal. <span class="hud-hot">Vercel degraded</span> in eu-west.</p>
`.trim()

const schema = {
  title: z
    .string()
    .describe('Short heading for the panel, two to four words. e.g. "SEARCH RESULTS", "INBOX".'),
  html: z
    .string()
    .describe(
      'The panel body as an HTML fragment, composed using the design system in ' +
        'this tool description. Author it for the specific content — a list, an ' +
        'image, a number and a caption, whatever fits.',
    ),
  anim: z
    .enum(['materialise', 'sweep', 'unfold', 'stagger', 'snap'])
    .default('materialise')
    .describe(
      'How it arrives. materialise = scan-wipe reveal, the default. ' +
        'sweep = slides in from the edge, good for results. ' +
        'unfold = expands vertically, good for images. ' +
        'stagger = children land one after another, good for lists. ' +
        'snap = instant with a flicker, good for alerts and single figures.',
    ),
  slot: z
    .enum(['right', 'left', 'wide'])
    .default('right')
    .describe(
      'Where it sits. right = the default stack beside the reactor. ' +
        'left = the opposite side, for a second simultaneous panel. ' +
        'wide = a broader card under the reactor, for images or dense tables.',
    ),
  accent: z
    .enum(['default', 'amber', 'violet', 'green', 'red'])
    .default('default')
    .describe(
      'Colour identity. default = the interface cyan. amber = caution or ' +
        'pending. violet = generated or synthetic content. green = confirmed ' +
        'or healthy. red = failure or alert. Use it meaningfully, not decoratively.',
    ),
  hold: z
    .enum(['turn', 'sticky'])
    .default('turn')
    .describe(
      'turn = clears when the user next speaks, the default. ' +
        'sticky = stays until replaced; use only when the user will refer back to it.',
    ),
}

const DESCRIPTION = `Put something on the JARVIS heads-up display.

You are designing the panel, not filling a template: compose the markup for the
content at hand and pick the animation, position and colour that suit it.

Use it whenever the answer is worth seeing rather than hearing — search results,
images, screenshots, lists, a figure, a short readout. If you searched, show the
results; if you generated an image, show it; if pictures came back, show the
pictures rather than describing them, and embed a video so it plays.

Call it before or while you speak. Never read a panel aloud — say what it means.
Speech stays one or two sentences however dense the panel is.

${DESIGN_SYSTEM}`

/**
 * Panel ids are React keys and they arrive in bursts, so `Date.now()` alone
 * collides. A random suffix looked like it solved that but was written
 * unpadded, so `p1700000000001` (from suffix 1) and `p170000000000` + `1`
 * are the same string. A counter is simply unique.
 */
let seq = 0

// ---------------------------------------------------------------------------
// Blades
// ---------------------------------------------------------------------------

const BLADE_DESCRIPTION = `Open something on the blades — the big surface.

A panel is a card you glance at; a blade is something you LOOK at — a photograph
worth seeing, an article worth reading, a video worth watching. Blades stack,
newest in front, and can be pulled forward or thrown full screen.

  article — a web page. \`mode: "reader"\` strips it to the words and restyles
            them, always legible. \`mode: "live"\` shows the real page, for when
            the layout carries the meaning: a dashboard, a table, a chart. Both
            are served locally, so sites that block embedding still open.
  image   — one picture, full width.
  gallery — several pictures; the answer to an image search.
  video   — a direct .mp4/.webm file.
  embed   — a YouTube or Vimeo watch URL, turned into a player.
  markup  — your own HTML in the .hud-* system, when nothing above fits.
  camera  — the live camera view. Open it when they ask, or before you watch
            them do something; while it is open you can also review the seconds
            just past, which you cannot do otherwise. Needs no url.

Size is about reading. \`tall\` is a reading column, for any article they mean to
read. \`wide\` suits images, video and tables. \`full\` is for when the content IS
the answer. \`compact\` is a thumbnail that stays out of the way.

Call \`probe_url\` when unsure what a URL is; never judge by file extension.

Never open a blade they did not ask for and do not need.`

const bladeSchema = {
  title: z
    .string()
    .describe('Two to four words naming what this is, e.g. "REUTERS" or "MARK VII".'),
  kind: z
    .enum(['article', 'image', 'gallery', 'video', 'embed', 'markup', 'camera'])
    .describe('What is being opened. See the tool description.'),
  url: z
    .string()
    .optional()
    .catch(undefined)
    .describe(
      'The address, for article / image / video / embed. Use a URL that ' +
        'appeared verbatim in a tool result — never one you assembled yourself.',
    ),
  images: z
    .array(z.string())
    .optional()
    .catch(undefined)
    .describe('Image URLs, for kind "gallery". Four is a good number, eight the most.'),
  html: z
    .string()
    .optional()
    .catch(undefined)
    .describe('Your own markup, for kind "markup", in the .hud-* design system.'),
  mode: z
    .enum(['reader', 'live'])
    .optional()
    .catch(undefined)
    .describe('For kind "article": reader = the words restyled, live = the real page.'),
  size: z
    .enum(['compact', 'tall', 'wide', 'full'])
    .optional()
    .catch(undefined)
    .describe('tall = a reading column. wide = pictures and tables. full = the screen.'),
  hold: z
    .enum(['turn', 'sticky'])
    .optional()
    .catch(undefined)
    .describe('turn = closes when the user next speaks. sticky = stays until replaced.'),
}

const PROBE_DESCRIPTION = `Find out what is actually at a URL before showing it.

Returns what it is, whether it can be reached, and — for a web page — its title,
how much readable prose it holds, and a lead image if it has one.

Call it whenever you are about to show something and are not certain of it. It
avoids the visible failure: a blade opening onto a blank rectangle, or an image
that turns out to be an HTML page, while you describe it as though it worked.

Its \`suggestion\` has only seen the bytes, not the conversation. Overrule it
whenever you have reason to.`

/**
 * @param {(panel: object) => void} emit - pushes the panel to the browser
 * @param {(blade: object) => void} emitBlade - pushes a blade to the browser
 */
export function displayServer(emit, emitBlade) {
  return createSdkMcpServer({
    name: 'jarvis',
    version: '1.0.0',
    instructions:
      'The JARVIS heads-up display. Use `display` to put content on screen ' +
      'alongside what you say.',
    // Never defer this behind tool search — if the model has to go looking for
    // it, it won't occur to it to show anything.
    alwaysLoad: true,
    tools: [
      tool('display', DESCRIPTION, schema, async (args) => {
        // Refuse rather than warn. Emitting anyway put a blank card on screen
        // and told the model nothing, so it had no reason to try again; handed
        // back as an error it gets one more go with actual content in it.
        //
        // The media test counts video and iframe as well as img, because a
        // panel whose whole point is a playable result carries no text at all —
        // rejecting it would refuse the one thing this tool was just taught to
        // do. <source> counts too: a <video> is often written with its src on
        // the child element rather than the parent.
        const text = String(args.html ?? '').replace(/<[^>]*>/g, '').trim()
        if (!text && !/<(img|video|iframe|source)\b/i.test(args.html ?? '')) {
          console.warn('[jarvis] display called with an empty body:', args.title)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  'Not shown: the panel body was empty. A panel needs visible ' +
                  'text or an image — call display again with the content ' +
                  'composed into the html argument.',
              },
            ],
          }
        }
        /**
         * Composed markup opens as a blade, not as a card.
         *
         * There is one surface now. A second place for things to appear meant
         * the user had two places to look and the model had a decision to make
         * every time it wanted to show something — and it made that decision
         * on grounds it could not possibly know, since only the person looking
         * at the screen knows whether they are glancing or reading.
         *
         * The tool keeps its name and its design system because the model is
         * fluent in both; only where the result lands has changed.
         */
        emitBlade({
          id: `p${Date.now().toString(36)}-${(seq++).toString(36)}`,
          title: String(args.title ?? '').trim() || 'DISPLAY',
          kind: 'markup',
          html: args.html,
          size: args.slot === 'wide' ? 'wide' : 'compact',
          hold: args.hold ?? 'turn',
        })
        return { content: [{ type: 'text', text: 'On screen.' }] }
      }),

      tool('blade', BLADE_DESCRIPTION, bladeSchema, async (args) => {
        const kind = args.kind
        const url = String(args.url ?? '').trim()
        const images = Array.isArray(args.images) ? args.images.filter(Boolean) : []

        // Refused rather than emitted, for the same reason the display tool
        // refuses an empty body: a blade that opens onto nothing looks like the
        // interface failing, and the model gets no signal to try again.
        if (kind === 'gallery' && !images.length) {
          return refuse('Not opened: a gallery needs at least one image URL in `images`.')
        }
        if (kind === 'markup' && !String(args.html ?? '').trim()) {
          return refuse('Not opened: kind "markup" needs an `html` body.')
        }
        if (['article', 'image', 'video', 'embed'].includes(kind) && !url) {
          return refuse(`Not opened: kind "${kind}" needs a \`url\`.`)
        }

        const blade = {
          id: `b${Date.now().toString(36)}-${(seq++).toString(36)}`,
          title: String(args.title ?? '').trim() || 'DISPLAY',
          kind,
          url: url || undefined,
          images: images.length ? images.slice(0, 8) : undefined,
          html: args.html || undefined,
          mode: args.mode ?? 'reader',
          // A reading column for anything meant to be read, a broad frame for
          // anything meant to be looked at. Getting this wrong is the difference
          // between an article you can follow and one in a letterbox.
          size: args.size ?? (kind === 'article' ? 'tall' : 'wide'),
          hold: args.hold ?? 'turn',
        }
        emitBlade(blade)
        return { content: [{ type: 'text', text: `Open on the blades as "${blade.title}".` }] }
      }),

      tool(
        'probe_url',
        PROBE_DESCRIPTION,
        { url: z.string().describe('The absolute URL to inspect.') },
        async (args) => {
          const report = await probeUrl(String(args.url ?? ''))
          return { content: [{ type: 'text', text: JSON.stringify(report, null, 1) }] }
        },
      ),
    ],
  })
}

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
