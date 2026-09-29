# J.A.R.V.I.S. - REFINED

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

Claude Code is the default brain and needs no API key when bridge mode uses your
existing Claude Code login. OpenAI and other OpenAI-compatible providers are
optional alternatives configured on the bridge; their keys stay server-side.
The main model work runs remotely. Speech output uses Kokoro locally in the
browser by default, with a distinct voice design for each visual theme.
**ElevenLabs is an optional add-on** for transcription or an explicitly enabled
cloud voice; without it, speech still works with no subscription or API key.

## Jarvis and Jarvis-refined

This is the provider-aware version of Jarvis. The original Jarvis is Claude-first: it starts Claude at bridge startup and uses Claude Code for its model, native filesystem tools, and configured MCP servers. The original does not include the provider selector, OpenAI/local adapters, automatic
provider failover, or the shared provider tool broker.

Jarvis-refined can switch between Claude, OpenAI, and an OpenAI-compatible local
model from the HUD. Its bridge shares memory, preferences, skills, MCP tools,
browser, vision, UI, display, and restricted filesystem tools across providers.
Claude-native tools and Anthropic-hosted web search remain Claude-specific.
Claude starts lazily, so OpenAI or Local can run without a Claude login unless
Claude is selected or automatic failover needs it.

---

## Requirements

**In one line:** one configured provider, plus two free things every computer
can have — Node.js and Chrome. Claude needs a Claude Code login; OpenAI needs an
OpenAI API key; Local needs an OpenAI-compatible endpoint.

- **Claude Code, installed and logged in** — required only when Claude is
  selected or used for automatic failover. Install it with the official method —
  `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **OpenAI API key** — required only when OpenAI is selected. Set
  `OPENAI_API_KEY` on the bridge; it is never sent to the browser.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — enables sharper transcription and an
  optional cloud voice. Without it, Kokoro speech generation runs locally and
  voice recognition falls back to the browser.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> In a noisy room, press **K** to switch to [push-to-talk](#push-to-talk):
> JARVIS then only hears you while you hold a key.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has three tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **OpenAI key present** → OpenAI transcription through the same bridge endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking is local by default.** Kokoro runs in the browser through WebGPU,
  using a different base voice, pace, EQ and compression profile for each
  theme. Its Apache-licensed model is downloaded once (about 330 MB) and cached
  by the browser. If Kokoro cannot load, speech falls back to the operating
  system voice. Set `VITE_USE_ELEVENLABS=true` to explicitly prefer the cloud
  voice instead.

So it works with no speech-service keys. Capability detection lives in
`src/lib/capabilities.ts`, which probes the bridge's `GET /health` (returning
`{ ok, tts, stt }`) once at boot and selects transcription and fallback paths.

| Theme | Local voice design |
|---|---|
| JARVIS | George, measured British delivery with clean presence |
| HAL 9000 | Michael, slower and tightly compressed with a darker bandwidth |
| WOPR | Fenrir, command-terminal pacing with narrow communications EQ |
| MU/TH/UR | Nicole, slower ship-mainframe delivery with dense compression |
| LCARS | Nova, even starship-computer delivery with a crisp intercom band |

### Push-to-talk

By default JARVIS listens all the time and wakes on his name. In a noisy room
that means background chatter and television can wake him or leak into a
command. Push-to-talk turns that off: **nothing is transcribed unless you are
holding the push-to-talk key or button.**

- Press **K** to toggle between push-to-talk and hands-free (wake word) mode.
- **Hold** the push-to-talk key, speak, and **release**. Releasing ends the
  sentence and sends it immediately — there is no pause detection to wait for.
- Holding the key while JARVIS is talking cuts him off at once.
- The default key is **Right Alt**. Press **Shift+K**, then press any key or a
  mouse button (middle, right, back or forward — not left) to choose another.
  **Escape** cancels the choice. Keys already used by JARVIS (listed under
  [Controls](#controls)) cannot be chosen; **Space** can.
- The on/off setting and the chosen key are remembered in this browser
  (`localStorage` key `jarvis-ptt`).

What changes while push-to-talk is on:

- **The wake word is disabled.** Saying "Hey Jarvis" does nothing; the key is
  the wake word.
- **Voice-profile checking is skipped.** Holding the key already proves it is
  you, so a noisy room cannot cause your own voice to be rejected.
- **With a speech service (ElevenLabs/OpenAI)**, the energy detector no longer
  starts recordings. Audio is recorded from key-down to key-up only (up to two
  minutes; taps shorter than a quarter of a second are ignored).
- **With browser speech recognition**, the recogniser only runs while the key is
  held.
- The microphone stream itself stays open so the reactor can still pulse with
  sound, but nothing heard outside a key press is recorded or transcribed.

The footer hint shows the current mode and key. `window.__voice.ptt` in the
browser console reports whether push-to-talk is active.

---


## Background agents

JARVIS can hand longer work to background agents: "get stealthDash ready for
release", "research paid code bounties and write it up", "check the network
every six hours". He creates a **goal**; a coordinator plans it into tasks; up to
three agents work in parallel in their own git worktrees or folders; the
coordinator reviews each result and decides what happens next.

Agents act on their own, with four hard stops that always wait for you:
spending money, deleting data outside their workspace (or force-pushing /
rewriting history), sending credentials, and messaging someone new. JARVIS reads
approvals out; you can also answer on the agent board (press **A**).

The agents run in their own service so restarting JARVIS never interrupts them:

```bash
npm run agents:token                                    # once: shared secret
cp deploy/jarvis-agents.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-agents
# then run the bridge with JARVIS_AGENTS=1
```

State lives in `~/.config/jarvis/agents/` (goals, tasks, approvals and an
`events.jsonl` audit log of every agent action); workspaces in `~/.jarvis-work/`.
"Clean up the agent workspaces" removes those of finished goals.

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** are not stored on disk, so the bridge cannot see them — it works from
> the servers in `~/.claude.json` (about 14), not the claude.ai ones.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

Keyboard shortcuts are single keys with no modifier (except **Shift+K**) and are
ignored while typing in a text field.

### Voice and conversation

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him (hands-free mode only; the phrase depends on the theme) |
| Just speak | Interrupt him mid-sentence (barge-in; hands-free mode) |
| **Space** | On the ignition screen: power on. Afterwards: start a turn without the wake word, or interrupt him and listen if he is busy |
| **K** | Toggle [push-to-talk](#push-to-talk) on or off |
| **Shift+K** | Choose the push-to-talk key or mouse button (**Escape** cancels) |
| **Right Alt** (default, hold) | Push-to-talk: talk while held, send on release |
| **Escape** | Stand down — stop talking, clear the caption, go back to sleep |

### Interface

| Key | Does |
|---|---|
| **V** | Cycle to the next installed voice and speak a sample |
| **G** | Turn the camera and hand-gesture control on or off |
| **A** | Show or hide the agent board |
| **P** | Open or close the voice profile (enrol, re-record, or forget your voiceprint) |
| **D** | Show or hide the live diagnostics panel |
| **T** | One-line audio self-test (speaks a fixed line and reports if no sound was produced) |

### Blades (only while a blade is open)

| Key | Does |
|---|---|
| **E** | Expand the front blade to full screen, or restore it |
| **X** | Close the front blade |
| **]** | Bring the next blade to the front |
| **[** | Bring the previous blade to the front |

### Other ways to start

| Action | Does |
|---|---|
| Click **INITIALISE** | Power on |
| Clap | Power on (ignition screen only) |

---

## Boot sequences

Every theme has its own power-up sequence and sound design:

| Theme | Intro |
|---|---|
| JARVIS | Segmented diagnostics, reticle assembly, suit schematic and reactor ignition |
| HAL 9000 | Quiet logic diagnostics resolving into a bright optical lens |
| WOPR | Dial-up terminal session, strategic network grid, DEFCON display and game prompt |
| MU/TH/UR | Mechanical shutters, line-printed ship checks and priority-access terminal |

The new themes also keep their identity after boot. HAL uses slow optical pulses
and restrained frame movement; WOPR scans in discrete CRT steps; MU/TH/UR moves
its side rails like machinery and updates data with a line-printer cadence.

---

## Configuration

Everything is optional in bridge mode. Copy `.env.example` to `.env.local` for
both frontend settings and local bridge credentials; shell environment variables
take precedence over values in that file.

### Changing themes

Themes are selected when the frontend starts. Create or edit `.env.local` in
the project root and set `VITE_THEME` to the theme you want:

```dotenv
VITE_THEME=wopr
```

Then stop and restart `npm start` or `npm run dev`. Reloading the browser alone
does not pick up a changed environment variable.

| Value | Interface | Wake phrase |
|---|---|---|
| `stark` | Cyan holographic JARVIS HUD (default) | “Hey Jarvis” |
| `hal` | Restrained red optical-computer console | “Hal” |
| `wopr` | Amber military CRT command grid | “Joshua” |
| `mother` | Green industrial mainframe terminal | “Mother” |
| `lcars` | Voyager-style LCARS: blue elbow frame, data cells, starship chirps | “Computer” |

For a temporary preview on macOS or Linux, set the value for one command
without changing `.env.local`:

```bash
VITE_THEME=hal npm run dev
```

The selected theme controls the palette, typography, complete intro, interface
sounds, ambient bed, live animations, wake phrase, scene lighting and spoken
persona. It is fixed for that browser build; there is no in-app theme selector.

Interface cues are synthesized locally with Web Audio and need no downloaded
assets. To replace a cue, add `boot.mp3`, `wake.mp3`, `listen.mp3`, `tool.mp3`,
`done.mp3` or `error.mp3` under the theme's directory:

```text
public/audio/hal/
public/audio/wopr/
public/audio/mother/
```

The default `stark` theme reads overrides directly from `public/audio/`.
Only add recordings you have permission to redistribute. Fan archives may make
recognizable franchise clips downloadable without granting reuse rights; those
files should remain local unless the copyright holder licenses them for your
distribution.

To use OpenAI, set `OPENAI_API_KEY` in the environment of the bridge process
before `npm start`. Choose Claude or OpenAI from the HUD provider menu. The
selection is remembered in this browser. Set `OPENAI_MODEL` to override the
default `gpt-4.1-mini`. For an OpenAI-compatible local server, set both
`JARVIS_LOCAL_URL` (including `/v1`) and `JARVIS_LOCAL_MODEL`; Local then appears
in the menu. `JARVIS_PROVIDER` sets the initial choice for new browsers.

Claude, OpenAI, and Local share the bridge MCP tool broker. This includes the
Jarvis display, UI, browser, vision, memory, and every configured local or
remote MCP server. OpenAI-compatible providers receive standard function
schemas and their tool calls execute in the bridge, so provider API keys never
reach the browser. Claude-native built-in tools and Anthropic-hosted web search
remain Claude-specific; use an MCP search server for those capabilities with
OpenAI or Local.

All providers also receive the `jarvis_files` tools: read text files, list
directories, search text below a permitted root, and write files when
`JARVIS_ALLOW_WRITES=1`. The permitted roots are the home directory, temporary
directories, and any paths listed in `JARVIS_FILE_ROOTS`; paths outside them are
rejected by the bridge.

If a provider runs out of credits or hits a rate limit before emitting text or
using a tool, the bridge switches to another configured provider and retries
the question. Partial answers and tool actions are never retried
automatically. Switching or automatic failover sends recent conversation text
to the newly selected provider for context.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `medium` | Reasoning effort |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_FILE_ROOTS` | — | Roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | — | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | OpenAI speech-recognition model |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_THEME` | `stark` (default), `hal`, `wopr`, `mother`, or `lcars` |
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `kokoro` (default) or `system` |
| `VITE_KOKORO_VOICE` | Optional override for the theme's Kokoro base voice |
| `VITE_USE_ELEVENLABS` | Explicitly prefer the ElevenLabs voice |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time in
`decideTool()` in `bridge/server.mjs`, not at the moment of use. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

---

## Security

All of this lives in `bridge/server.mjs`:

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
