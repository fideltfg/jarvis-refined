# J.A.R.V.I.S. Refined

JARVIS Refined is a browser-based voice assistant with a real-time 3D HUD. The
browser handles the interface, microphone, wake-word detection, and speech
output. A local Node.js bridge connects it to Claude, OpenAI, or an
OpenAI-compatible model and to configured MCP tools. Tools can search the web,
generate media, control a phone or browser, and work with other services exposed
by your MCP setup.

The app includes multiple character themes, provider selection and failover,
locally generated Kokoro speech, an optional persistent background-agent
service, and a remote browser relay for driving Chrome on another machine. The
agent board brings background goals and Claude subagents into one view. Voice
can be used hands-free or with configurable push-to-talk (toggle with **K**;
hold Right Alt by default, or press **Shift+K** to bind a key or mouse button).
Claude uses the existing Claude Code login by default; provider credentials
remain on the bridge. See [Architecture and capabilities](docs/architecture.md)
for the runtime overview.

## Get Started

You need Node.js 20+, Chrome or Edge in a normal browser window, and at least
one configured model provider. Follow [Getting started](docs/getting-started.md)
for provider setup and launch options. For a read-only session:

```bash
npm install
npm run start:readonly
```

Open the URL printed by Vite, click **INITIALISE**, allow microphone access, and
use the selected theme's wake phrase. Embedded browser previews commonly block
microphone access. `npm start` also launches the bridge and frontend, but enables
effectful tools; review [Tools and safety](docs/tools-and-safety.md) before
using it.

## Guides

- [Getting started](docs/getting-started.md): prerequisites, installation, and launch options.
- [Architecture and capabilities](docs/architecture.md): browser, bridge, tools, HUD, and runtime flow.
- [Providers and voice](docs/providers-and-voice.md): model selection, failover, transcription, and speech.
- [Tools and safety](docs/tools-and-safety.md): write controls, security boundaries, and remote browser relay setup.
- [Background agents](docs/background-agents.md): long-running goals, approvals, persistence, and service setup.
- [Configuration reference](docs/configuration.md): environment variables and their defaults.
- [Themes](docs/themes.md): built-in themes, controls, and audio behavior.
- [Troubleshooting](docs/troubleshooting.md): microphone, audio, provider, and bridge checks.
- [Theme package authoring](public/themes/README.md): theme files, schema, styles, persona, and audio assets.

## Development

| Command | Purpose |
|---|---|
| `npm run start:readonly` | Start the bridge and Vite together with effectful tools disabled. |
| `npm start` | Start the bridge and Vite together with effectful tools enabled. |
| `npm run setup` | Run the advisory machine preflight. |
| `npm run bridge` | Start only the read-only bridge. |
| `npm run bridge:writes` | Start only the bridge with effectful tools enabled. |
| `npm run dev` | Start only the Vite frontend. |
| `npm run agents` | Start the optional background-agent service. |
| `npm run relay:token` | Generate a token for remote browser relays. |
| `npm test` | Run Node test suites. |
| `npm run build` | Type-check and build the production frontend. |
| `npm run lint` | Run Oxlint. |

See the guides above for configuration and operational details. The project is
MIT-licensed; audio assets may have separate redistribution requirements, as
described in [Themes](docs/themes.md).
