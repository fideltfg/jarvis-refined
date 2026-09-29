# Getting Started

## Requirements

- Node.js 20 or newer.
- Google Chrome or Microsoft Edge in a regular browser window. JARVIS needs
  WebGL and microphone access; embedded editor previews often deny the latter.
- One model provider:
  - **Claude:** install Claude Code and complete its login. The bridge reuses
    that login; no separate Anthropic API key is needed.
  - **OpenAI:** provide `OPENAI_API_KEY` to the bridge process.
  - **Local:** provide an OpenAI-compatible endpoint and model name.
- Optional speech service credentials. Without them, browser speech recognition
  and local Kokoro speech remain available.

Run `npm run setup` after installing dependencies for an advisory check of Node,
Claude Code, configured MCP servers, and optional ElevenLabs availability. It
does not install or change anything.

## Install and Run

From the repository directory:

```bash
npm install
npm start
```

The command starts the local bridge and Vite frontend together. Open the URL Vite
prints (normally `http://localhost:5173`) in Chrome or Edge, click
**INITIALISE**, grant microphone permission, and say the selected theme's wake
phrase. The default theme uses **“Hey Jarvis”**.

To run the two main processes separately, use two terminals:

```bash
# Terminal 1: model and tools
npm run bridge
```

```bash
# Terminal 2: browser app
npm run dev
```

Open the Vite URL in a real browser window. Press **Ctrl+C** in each terminal
when running processes separately.

## Read-Only by Default

The bridge starts with effectful tools disabled. Search, reading, and generation
may work, while actions such as sending, clicking, deleting, or installing are
blocked. To enable actions for a session, run `npm run bridge:writes` instead of
`npm run bridge`, or start the combined launcher with:

```bash
npm start -- --writes
```

Review [Tools and safety](tools-and-safety.md) before enabling writes.

## Next Steps

- Configure providers, themes, and voice in the [Configuration reference](configuration.md).
- Learn how the bridge and browser share work in [Architecture and capabilities](architecture.md).
- Enable persistent background work using [Background agents](background-agents.md).
