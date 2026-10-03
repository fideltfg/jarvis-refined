# Architecture and Capabilities

JARVIS Refined runs as a browser application plus a local Node.js bridge. The
browser owns the visual experience and live audio loop; the bridge owns model
connections, credentials, MCP servers, and guarded local operations.

```text
Microphone / keyboard / optional camera
                 |
                 v
Browser: React HUD, Three.js reactor, wake word, VAD, transcription, speech
                 | WebSocket + HTTP (default port 8787)
                 v
Bridge: provider adapters, tool broker, MCP servers, policy checks, media proxy
                 |
                 v
Claude / OpenAI / compatible local model and configured MCP services
```

## Runtime Flow

1. The browser loads the selected theme and waits for the user to initialize the
   audio session.
2. Voice activity and wake-word handling run in the browser. The browser sends
   user turns to the bridge over WebSocket in bridge mode.
3. The selected provider answers directly or requests tools through the bridge.
   The bridge runs permitted tools and returns their results to the conversation.
4. The browser renders the response, speaks it, and displays any generated HUD
   panels or media.

The bridge is implemented in `bridge/server.mjs`. The React entry point and
experience are under `src/`; the optional goal coordinator, scheduler, and
workers are under `agents/`. `scripts/start.mjs` launches the bridge and Vite
together and shuts both down if either exits.

## Model and Tool Layer

Claude is the default provider and uses the Claude Agent SDK with the local
Claude Code login. OpenAI and configured OpenAI-compatible endpoints use the
bridge's shared function/tool broker. The broker exposes JARVIS's own UI,
display, browser, vision, memory, and restricted filesystem tools alongside MCP
servers found in the local Claude Code configuration.

Claude-native tools and Anthropic-hosted web search remain Claude-specific.
OpenAI and local providers need MCP servers for equivalent external services.
The browser's provider and model menus offer only what is configured on the
bridge. The browser sends the chosen provider and model with each question; the
bridge checks both against its own lists and falls back to the provider's
default model for anything it does not offer. See
[Providers and voice](providers-and-voice.md) for provider behavior.

## Browser Experience

The HUD uses React and Three.js. Themes define the character, palette, sounds,
voice profile, wake phrase, and boot sequence. The user can speak, use keyboard
controls, and optionally enable hand tracking with **G**. Hand tracking is off
until explicitly enabled and requires camera permission.

JARVIS can change supported HUD elements through UI tools, including reactor
appearance, theme accents, visibility, effects, and orbiting images. A `display`
tool composes rich panels in the HUD's constrained design system. Panel markup is
sanitized in the browser; the bridge fetches remote media through guarded
`/img` and `/media` routes.

## Optional Background Service

The background-agent service is a separate process so active work can continue
while the browser or bridge restarts. It plans goals into tasks, schedules
workers, persists state, and reports events back to the HUD when enabled. It is
disabled by default. Setup and its approval model are covered in
[Background agents](background-agents.md).
