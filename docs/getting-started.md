# Getting Started

This guide gets one browser and one model provider running on the same machine.
For other topologies, continue with the [Deployment guide](deployment.md).

## Requirements

- Node.js 20 or newer and npm.
- Chrome or Edge in a normal browser window. JARVIS needs WebGL and microphone
  access; embedded editor previews often deny microphone access.
- One model provider:
  - **Claude:** install Claude Code, run `claude`, and complete login. The bridge
    reuses that login; no separate Anthropic key is needed.
  - **OpenAI:** set `OPENAI_API_KEY` in `.env.local` or in the bridge process.
  - **Local:** run an OpenAI-compatible server and set `JARVIS_LOCAL_URL` plus
    `JARVIS_LOCAL_MODEL`.

Speech credentials are optional. Browser recognition and local Kokoro speech
work without ElevenLabs or OpenAI transcription.

## Install

From the repository root:

```bash
npm install
npm run setup
```

The preflight is advisory and changes nothing. It checks Node, Claude Code,
configured MCP servers, and optional ElevenLabs availability.

Copy the example only when you need to change a setting:

```bash
cp .env.example .env.local
```

Blank entries behave as unset. Add only the values you use, never commit real
credentials, and consult the [Configuration reference](configuration.md) for
defaults and security implications.

## First run

Start safely with effectful tools blocked:

```bash
npm run start:readonly
```

Open the printed Vite URL (normally `http://localhost:5173`), click
**INITIALISE**, grant microphone permission, and say the active theme’s wake
phrase. The default is “Hey Jarvis.” Press **K** to toggle push-to-talk; hold
**Right Alt** by default, or press **Shift+K** to bind another key or mouse
button. Press **G** to opt into camera-based hand tracking.

Run the two processes separately when you want independent logs:

```bash
# terminal 1: model and tools
npm run bridge

# terminal 2: browser interface
npm run dev
```

Press **Ctrl+C** to stop. The combined launcher stops both halves when either
one exits.

## Allowing actions

Read-only mode permits retrieval and generation but blocks effectful operations
such as sending, tapping, deleting, installing, or paying. Enable those actions
only for a session you supervise:

```bash
npm start
# or, when running separately
npm run bridge:writes
```

This is an allow gate, not blanket authorization: provider and tool approval
rules still apply. See [Tools and safety](tools-and-safety.md).

## Next steps

- Pick models and voices in [Providers and voice](providers-and-voice.md).
- Change characters or learn the controls in [Themes](themes.md).
- Choose a local, LAN, or service layout in [Deployment](deployment.md).
- Run JARVIS as services that start at boot with `./scripts/install.sh`; see
  [Run as services at boot](deployment.md#run-as-services-at-boot-scriptsinstallsh).
- Add persistent work using [Background agents](background-agents.md).
