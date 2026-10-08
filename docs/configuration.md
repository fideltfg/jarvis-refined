# Configuration Reference

This is the canonical list of supported settings. `.env.example` is a copyable
template; this page explains the behavior and trade-offs.

The bridge loads `.env.local` and `~/.config/jarvis/secrets.env`. Values already
present in the process environment take precedence. Vite also reads `.env.local`
and exposes only `VITE_*` names to frontend code. Treat every `VITE_*` value as
public: it is compiled into browser JavaScript.

When installed as services with `scripts/install.sh`, both systemd units also
load `~/.config/jarvis/secrets.env` and then `~/.config/jarvis/service.env`
into the process environment; put host settings such as `JARVIS_HOST`, TLS
paths, origins and ports in `service.env`.

Boolean settings accept the values shown below; frontend flags accept
`true`/`false` or `1`/`0`. Restart the affected process after a change, and
rebuild static assets after changing `VITE_*` settings.

## Bridge and model provider

| Variable | Default | Meaning |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | HTTP and WebSocket port used by the bridge. Keep `VITE_BRIDGE_URL` or the Vite proxy aligned. |
| `JARVIS_MODEL` | `claude-opus-5` | Default Claude model for bridge conversations, listed first in the HUD's model menu. Use a model name accepted by the installed Claude Agent SDK. |
| `JARVIS_CLAUDE_MODELS` | `opus,sonnet,haiku` | Comma-separated Claude models offered in the HUD's model menu after `JARVIS_MODEL`. Setting it replaces the default extras. |
| `JARVIS_EFFORT` | `high` | Claude reasoning effort. Lower values can reduce latency; unsupported values are passed to the SDK and may fail there. |
| `JARVIS_MAX_TURNS` | `24` | Maximum model/tool turns in one bridge request. Raise only for legitimate long tool chains. |
| `JARVIS_PROVIDER` | `claude` | Initial HUD provider. It is used only if that provider is actually configured. |
| `OPENAI_API_KEY` | unset | Enables OpenAI chat and, when ElevenLabs is unavailable, OpenAI transcription. Keep it bridge-side. |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Default OpenAI chat model, listed first in the HUD's model menu. |
| `JARVIS_OPENAI_MODELS` | unset | Comma-separated extra OpenAI chat models offered in the HUD's model menu after `OPENAI_MODEL`. |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | OpenAI speech-to-text model. |
| `JARVIS_LOCAL_URL` | unset | Base URL for one OpenAI-compatible endpoint, commonly ending in `/v1`. Requires `JARVIS_LOCAL_MODEL`. |
| `JARVIS_LOCAL_MODEL` | unset | Model name served by the shorthand local endpoint. Requires `JARVIS_LOCAL_URL`. |
| `JARVIS_LOCAL_API_KEY` | unset | Optional key for the shorthand local endpoint. |
| `JARVIS_ENDPOINTS` | unset | JSON endpoint array or path to a JSON file. Replaces the shorthand local endpoint when it yields valid entries. Each distinct OpenAI-compatible `model` appears in the HUD's model menu for Local. |
| `JARVIS_DEBUG` | off | Set to `1` for additional bridge message-event logging. Logs can contain operational metadata. |

Claude uses the existing Claude Code login. OpenAI and local providers use the
bridge tool broker; Claude-only hosted tools do not automatically become
available to them. The HUD's model menu is built from the variables above; see
[Choosing a model](providers-and-voice.md#choosing-a-model).

## Bridge safety, state, and browser relay

| Variable | Default | Meaning |
|---|---|---|
| `JARVIS_ALLOW_WRITES` | off | Set to `1` to permit effectful tool classes. `npm start` and `npm run bridge:writes` set it for that process. |
| `JARVIS_ALLOWED_ORIGINS` | trusted local Vite/preview ranges | Comma-separated extra browser origins allowed to open the bridge WebSocket. Enter full origins such as `https://jarvis.lan:5173`. |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Set to `1` to accept clients with no `Origin` header. This weakens protection against local software and should normally remain off. |
| `JARVIS_FILE_ROOTS` | unset | Comma-separated extra roots the `/file` route may serve. Home and system temp roots are already allowed. |
| `JARVIS_MEMORY_FILE` | `~/.config/jarvis/pa.md` | Markdown file used by personal-assistant memory tools. |
| `JARVIS_HISTORY_FILE` | `~/.config/jarvis/sessions.json` | Copy of saved chat sessions that JARVIS searches to recall earlier conversations. |
| `JARVIS_SESSION_AGENTS_FILE` | `~/.config/jarvis/session-agents.json` | Persistent summary of session/subagent activity shown on the board. |
| `JARVIS_CONVERSATIONS_DIR` | `~/.config/jarvis/conversations` | Private bridge conversation checkpoints used to recover context across reconnects and restarts. |
| `JARVIS_LOOSE_ENDS_FILE` | `~/.config/jarvis/loose-ends.md` | Markdown ledger of unfinished assistant work shown in the LCARS Loose ends window. |
| `JARVIS_RELAY_TOKEN` | unset | Enables authenticated registration by a remote Chrome relay. Generate with `npm run relay:token`. |

Write permission does not bypass tool-specific confirmation or policy. File
roots expand what can be read or served, so add the narrowest directory rather
than a drive or filesystem root. See [Tools and safety](tools-and-safety.md).

## Speech on the bridge

| Variable | Default | Meaning |
|---|---|---|
| `ELEVENLABS_API_KEY` | unset | Enables ElevenLabs speech and Scribe transcription. The bridge can also discover it in the `elevenlabs` MCP entry in `~/.claude.json`. |
| `JARVIS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` | ElevenLabs voice ID used by the bridge speech endpoint. |

Without ElevenLabs, speech output falls back to the configured browser engine;
speech recognition can use OpenAI when its key exists or the browser path.

## Frontend and development server

| Variable | Default | Meaning |
|---|---|---|
| `VITE_THEME` | `stark` | Initial theme folder from `public/themes/`. `?theme=<id>` overrides it for that browser and persists the choice. |
| `VITE_BACKEND` | `bridge` | `bridge` uses the Node bridge; `direct` calls Anthropic from the browser. |
| `VITE_BRIDGE_URL` | `ws://localhost:8787` | Bridge WebSocket URL. A path such as `/bridge` uses the current origin and is recommended with Vite’s HTTPS proxy. |
| `VITE_TTS_ENGINE` | `kokoro` | `kokoro` for local neural speech or `system` for browser `speechSynthesis`. |
| `VITE_KOKORO_VOICE` | theme voice | Pins a supported Kokoro voice across themes. Invalid names fall back with a console warning. |
| `VITE_USE_ELEVENLABS` | `false` | Prefer bridge/cloud ElevenLabs output when available. |
| `VITE_ANTHROPIC_API_KEY` | unset | Required only by direct mode. It is exposed to anyone who can load the frontend. |
| `VITE_ELEVENLABS_API_KEY` | unset | Direct/browser ElevenLabs credential. Public in the bundle; prefer bridge-side `ELEVENLABS_API_KEY`. |
| `VITE_ELEVENLABS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` | Voice ID paired with the browser-side ElevenLabs key. |
| `VITE_PICOVOICE_ACCESS_KEY` | unset | Enables offline Porcupine wake-word detection; otherwise browser speech recognition listens for the wake phrase. |
| `PORT` | `5173` | Vite development-server port. The combined launcher automatically trusts this local origin. |
| `JARVIS_HOST` | Vite default/localhost | Vite bind address; use `0.0.0.0` for LAN access. This does not change the bridge bind. |
| `JARVIS_TLS_CERT` | unset | PEM certificate path for the Vite development server. Requires `JARVIS_TLS_KEY`. |
| `JARVIS_TLS_KEY` | unset | PEM private-key path for the Vite development server. Requires `JARVIS_TLS_CERT`. |

Supported Kokoro voices are `bm_george`, `bm_fable`, `bm_lewis`, `bm_daniel`,
`am_michael`, `am_fenrir`, `am_echo`, `am_onyx`, `af_nicole`, `af_sarah`,
`af_heart`, `af_bella`, `af_nova`, and `af_kore`.

## Direct-mode MCP integrations

These settings are read only by the browser-direct configuration. Every token
or credential-bearing URL becomes visible in the built JavaScript and browser
developer tools. Use them only for a private local demo; bridge mode with MCP
servers configured in Claude Code is the secure default.

| Variable | Enables | Notes |
|---|---|---|
| `VITE_ZAPIER_MCP_URL` | Zapier | The URL itself is a credential. |
| `VITE_PIPEDREAM_MCP_URL` | Pipedream | The URL itself can be a credential. |
| `VITE_NOTION_TOKEN` | Notion | Sent as a bearer token to the fixed Notion MCP URL. |
| `VITE_LINEAR_TOKEN` | Linear | Sent as a bearer token to the fixed Linear MCP URL. |
| `VITE_GITHUB_TOKEN` | GitHub | Sent as a bearer token to the GitHub Copilot MCP URL. |
| `VITE_STRIPE_TOKEN` | Stripe | Grants the scope of the supplied Stripe credential. |
| `VITE_SENTRY_TOKEN` | Sentry | Sent to the fixed Sentry MCP URL. |
| `VITE_HOMEASSISTANT_MCP_URL` | Home Assistant | Must be reachable by Anthropic; requires `VITE_HOMEASSISTANT_TOKEN`. |
| `VITE_HOMEASSISTANT_TOKEN` | Home Assistant | Required together with its MCP URL. |

## Model endpoint pool

`JARVIS_ENDPOINTS` declares conversation and worker capacity as an inline JSON
array or a path to a JSON file. Secrets are referenced by environment-variable
name, never embedded in the JSON.

```json
[
  { "id": "claude", "kind": "anthropic", "concurrency": 3 },
  { "id": "rigel", "kind": "openai", "baseURL": "http://10.0.0.9:11434/v1",
    "model": "llama3.1:8b", "concurrency": 2, "label": "the big box" },
  { "id": "research-gateway", "kind": "gateway", "baseURL": "https://gateway.lan",
    "model": "local-model", "kinds": ["research"], "apiKeyEnv": "GATEWAY_TOKEN" },
  { "id": "remote-host", "kind": "remote", "baseURL": "https://remote-host:8789",
    "kinds": ["research", "ops"], "apiKeyEnv": "REMOTE_HOST_TOKEN" }
]
```

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Unique stable name. A task can name it to pin execution. Duplicate ids are rejected. |
| `kind` | `openai` | Protocol: `anthropic`, `openai`, `gateway`, or `remote`. |
| `baseURL` | required except `anthropic` | Endpoint base URL; include `/v1` when the server expects it. `remote` requires HTTPS. |
| `model` | required for `openai` | Model name understood by that endpoint. |
| `concurrency` | `1` | Positive integer capacity advertised to the scheduler. |
| `kinds` | all locally; `research`,`ops` remotely | Optional task allow-list: `code`, `research`, `marketing`, `ops`, `admin`. Remote entries are always reduced to travel-safe kinds. |
| `apiKeyEnv` | unset | Name of the process environment variable containing the credential. |
| `weight` | `1` | Tie-break preference between equally loaded eligible endpoints. |
| `label` | `id` | Human-readable name displayed on the board. |

`anthropic` uses the Anthropic protocol/login. `openai` supports OpenAI-compatible
conversation and summarization. `gateway` is an Anthropic-compatible proxy and
is the only non-Claude protocol shape usable by Agent SDK workers. `remote`
delegates the entire task to the standalone runtime and permits only research
and ops. Malformed entries are logged and skipped; an unreachable endpoint is
temporarily avoided. See [Remote agent deployment](remote-agent.md).

## Background-agent service

| Variable | Default | Meaning |
|---|---|---|
| `JARVIS_AGENTS` | off | Set to `1` in the bridge process to expose background-agent tools and board events. |
| `JARVIS_AGENTS_TOKEN` | required by service | Shared bearer token used by the bridge and agent API. Generate with `npm run agents:token`. |
| `JARVIS_AGENTS_HOST` | `127.0.0.1` | Agent API bind address. Non-loopback binds require its TLS certificate and key. |
| `JARVIS_AGENTS_PORT` | `8788` | Agent API port; the standalone unit uses `8789`. |
| `JARVIS_AGENTS_TLS_CERT` | unset | PEM certificate-chain path for the agent API. Must be paired with the key. |
| `JARVIS_AGENTS_TLS_KEY` | unset | PEM private-key path for the agent API. Must be paired with the certificate. |
| `JARVIS_AGENTS_TLS_CA` | unset | CA bundle enabling mutual TLS. Current remote dispatch cannot present a client certificate, so do not set it on a receiving remote worker. |
| `JARVIS_AGENTS_DIR` | `~/.config/jarvis/agents` | Persistent goal, task, approval, and event state. |
| `JARVIS_WORK_DIR` | `~/.jarvis-work` | Shared generated-output root: `sessions/<conversation-id>` and `goals/<goal-id>/tasks/<task-id>`, each with reports, artifacts, logs and tmp folders. Set identically in bridge and agent service. Existing task paths are preserved. |
| `JARVIS_PROJECT_ROOTS` | unset | Additional comma-separated roots outside the home directory where chat file tools may edit. The home directory and `JARVIS_WORK_DIR` are writable when writes are enabled. Does not restrict shell or external MCP access. |
| `JARVIS_AGENTS_SONNET` | `claude-sonnet-5` | Default worker model alias. |
| `JARVIS_AGENTS_OPUS` | `claude-opus-5` | Higher-reasoning worker model alias. |
| `JARVIS_MAX_WORKERS` | endpoint capacity, minimum `3` | Process-wide worker ceiling. Non-numeric or zero values use the calculated default. |
| `JARVIS_HOST_LABEL` | OS hostname | Name attached to work reported from this host. |

Endpoint `concurrency` describes per-endpoint capacity; `JARVIS_MAX_WORKERS`
limits total simultaneous local workers. See [Background agents](background-agents.md)
for startup, workflow, approvals, and recovery.

## Standalone remote runtime

The installer writes these settings to `/etc/jarvis-remote-agent/agent.env`.
They normally should not be maintained by hand.

| Variable | Default | Meaning |
|---|---|---|
| `JARVIS_REMOTE_MODEL` | required | Exact model name served by the on-host OpenAI-compatible server. |
| `JARVIS_REMOTE_MODEL_URL` | installer: `http://127.0.0.1:11434/v1` | Loopback-only HTTP(S) URL ending in `/v1`; credentials, queries, and fragments are rejected. |
| `JARVIS_REMOTE_WORKERS` | `1` | Runtime concurrency, clamped from `1` through `8`. Keep the main endpoint declaration at or below this value. |

The remote runtime also consumes the agent token, host/port, TLS, state, and
work-directory settings above. Follow the complete [remote deployment procedure](remote-agent.md).
