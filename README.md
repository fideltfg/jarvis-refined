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
schemas and their tool calls execute in the bridge, so provider API keys never
# J.A.R.V.I.S. Refined

JARVIS Refined is a browser-based voice assistant with a real-time 3D HUD. The
browser handles the interface, microphone, and speech output; a local Node.js
bridge connects it to Claude, OpenAI, or an OpenAI-compatible model and to your
configured MCP tools.

The project builds on the original Claude-first Jarvis with provider selection,
a shared tool broker, optional provider failover, locally generated Kokoro
speech, multiple visual themes, and an optional background-agent service.

## Get Started

Requirements are Node.js 20+, Chrome or Edge in a normal browser window, and at
least one configured model provider. See [Getting Started](docs/getting-started.md)
for installation and first run. The short version:

```bash
npm install
npm start
```

Open the URL printed by Vite, click **INITIALISE**, allow microphone access, and
use the wake phrase for the selected theme. Embedded browser previews commonly
block microphone access.

## Guides

- [Getting started](docs/getting-started.md): prerequisites, installation, and launch options.
- [Architecture and capabilities](docs/architecture.md): browser, bridge, tools, HUD, and runtime flow.
- [Providers and voice](docs/providers-and-voice.md): model selection, failover, transcription, and speech.
- [Tools and safety](docs/tools-and-safety.md): MCP access, write controls, filesystem limits, and security boundaries.
- [Background agents](docs/background-agents.md): long-running goals, approvals, persistence, and service setup.
- [Configuration reference](docs/configuration.md): environment variables and their defaults.
- [Themes](docs/themes.md): selecting themes, controls, and audio behavior.
- [Troubleshooting](docs/troubleshooting.md): microphone, audio, provider, and bridge checks.
- [Theme package authoring](public/themes/README.md): theme files, schema, styles, persona, and audio assets.

## Development

| Command | Purpose |
|---|---|
| `npm start` | Start the bridge and Vite together (read-only actions). |
| `npm run setup` | Run the advisory machine preflight. |
| `npm run bridge` | Start only the bridge. |
| `npm run bridge:writes` | Start the bridge with effectful actions enabled. |
| `npm run dev` | Start only the Vite frontend. |
| `npm run agents` | Start the optional background-agent service. |
| `npm test` | Run Node test suites. |
| `npm run build` | Type-check and build the production frontend. |
| `npm run lint` | Run Oxlint. |

See [Architecture and capabilities](docs/architecture.md) for the source layout
and [Configuration reference](docs/configuration.md) before changing runtime
settings. The project is MIT-licensed; audio assets may have separate
redistribution requirements, as described in [Themes](docs/themes.md).
Prefer two terminals? Run them separately instead:
