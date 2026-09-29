# Configuration Reference

Bridge mode is the default. Settings are optional unless their feature is being
used. Put frontend settings in `.env.local`; provide bridge secrets to the shell
that starts the bridge. Shell environment variables take precedence. Do not
commit real credentials.

## Bridge

| Variable | Default | Purpose |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Bridge HTTP and WebSocket port. |
| `JARVIS_MODEL` | `claude-opus-5` | Claude model. |
| `JARVIS_EFFORT` | `high` | Claude reasoning effort. |
| `JARVIS_PROVIDER` | `claude` | Initial provider for new browsers, if configured. |
| `OPENAI_API_KEY` | unset | Enables the OpenAI provider and can enable OpenAI transcription. |
| `OPENAI_MODEL` | `gpt-4.1-mini` | OpenAI chat model. |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | OpenAI transcription model. |
| `JARVIS_LOCAL_URL` | unset | OpenAI-compatible endpoint URL, including `/v1` when required. |
| `JARVIS_LOCAL_MODEL` | unset | Model name for the local endpoint; both Local settings are required. |
| `JARVIS_LOCAL_API_KEY` | unset | Optional key for the local endpoint. |
| `JARVIS_ALLOW_WRITES` | off | Set to `1` to allow effectful bridge tools. |
| `JARVIS_ALLOWED_ORIGINS` | local dev origins | Additional allowed browser origins, comma-separated. |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Set to `1` to accept WebSocket clients with no Origin header. |
| `JARVIS_FILE_ROOTS` | unset | Additional permitted filesystem roots, comma-separated. |
| `ELEVENLABS_API_KEY` | unset | Enables ElevenLabs voice and transcription. |
| `JARVIS_VOICE_ID` | built-in default | ElevenLabs voice ID. |

The bridge can also find `ELEVENLABS_API_KEY` in the `elevenlabs` MCP server's
environment in `~/.claude.json`.

## Frontend

| Variable | Default | Purpose |
|---|---|---|
| `VITE_THEME` | `stark` | Theme folder in `public/themes/`. |
| `VITE_BACKEND` | `bridge` | Use the local bridge or `direct` Anthropic API mode. |
| `VITE_BRIDGE_URL` | `ws://localhost:8787` | Bridge WebSocket address. |
| `VITE_TTS_ENGINE` | `kokoro` | `kokoro` or browser `system` speech synthesis. |
| `VITE_KOKORO_VOICE` | theme-selected | Optional Kokoro voice override. |
| `VITE_USE_ELEVENLABS` | false | Explicitly prefer cloud speech when available. |
| `VITE_ANTHROPIC_API_KEY` | unset | Direct mode only; exposed to the browser. |

Only `VITE_` variables are bundled into frontend code. Never put provider
secrets in `VITE_` variables except when deliberately using direct mode for a
local demo.

## Background Agents

| Variable | Default | Purpose |
|---|---|---|
| `JARVIS_AGENTS` | disabled | Set to `1` in the bridge environment to expose agent tools. |
| `JARVIS_AGENTS_TOKEN` | required | Shared bearer token for the bridge and agent service. |
| `JARVIS_AGENTS_PORT` | `8788` | Agent service loopback port. |
| `JARVIS_AGENTS_DIR` | `~/.config/jarvis/agents` | Persistent goals, tasks, and event state. |
| `JARVIS_WORK_DIR` | `~/.jarvis-work` | Worker workspaces. |
| `JARVIS_AGENTS_SONNET` | `claude-sonnet-5` | Default agent-worker model. |
| `JARVIS_AGENTS_OPUS` | `claude-opus-5` | Higher-reasoning worker model. |

Generate and store the shared token with `npm run agents:token`. See
[Background agents](background-agents.md) for startup instructions.
