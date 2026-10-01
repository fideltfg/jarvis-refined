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
| `JARVIS_ENDPOINTS` | unset | Every model JARVIS can reach, as a JSON array or the path to a file holding one. See [Model endpoints](#model-endpoints). Overrides the `JARVIS_LOCAL_*` pair. |
| `JARVIS_LOCAL_URL` | unset | OpenAI-compatible endpoint URL, including `/v1` when required. Shorthand for a single endpoint. |
| `JARVIS_LOCAL_MODEL` | unset | Model name for the local endpoint; both Local settings are required. |
| `JARVIS_LOCAL_API_KEY` | unset | Optional key for the local endpoint. |
| `JARVIS_ALLOW_WRITES` | off | Set to `1` to allow effectful bridge tools. |
| `JARVIS_ALLOWED_ORIGINS` | local dev origins | Additional allowed browser origins, comma-separated. |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Set to `1` to accept WebSocket clients with no Origin header. |
| `JARVIS_RELAY_TOKEN` | unset | Shared secret that lets a browser relay on another machine register. Generate with `npm run relay:token`. |
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

## Model endpoints

`JARVIS_ENDPOINTS` declares, in one place, every machine that can run a model —
this box, another box on the network, or someone else's API. The conversational
brain picks from it, and background agents draw capacity from it per endpoint
instead of from one global number, so several modest hosts carry a queue
together. Give it a JSON array inline, or the path to a file holding one.

```json
[
  { "id": "claude",   "kind": "anthropic", "concurrency": 3 },
  { "id": "rigel",    "kind": "openai",  "baseURL": "http://11.0.0.9:11434/v1",
    "model": "llama3.1:8b", "concurrency": 2, "label": "the big box" },
  { "id": "rigel-gw", "kind": "gateway", "baseURL": "http://11.0.0.9:8080",
    "model": "llama3.1:8b", "concurrency": 1, "kinds": ["research"],
    "apiKeyEnv": "RIGEL_GATEWAY_TOKEN" },
  { "id": "remote-host", "kind": "remote", "baseURL": "https://remote-host:8789",
    "concurrency": 1, "kinds": ["research", "ops"], "apiKeyEnv": "REMOTE_HOST_TOKEN" }
]
```

| Field | Default | Purpose |
|---|---|---|
| `id` | required | Name for the endpoint. A task's `model` may be an id, which pins it to that machine. |
| `kind` | `openai` | How the endpoint is spoken to — see below. |
| `baseURL` | required except for `anthropic` | Include `/v1` where the server expects it. |
| `model` | required for `openai` | Model name as that endpoint knows it. |
| `concurrency` | `1` | How many jobs this machine carries at once. |
| `kinds` | all | Restrict the endpoint to some task kinds: `code`, `research`, `ops`, `admin`. |
| `apiKeyEnv` | unset | The *name* of the environment variable holding the key. Never the key itself. |
| `weight` | `1` | Tie-break preference when two endpoints are equally loaded. |
| `label` | the id | Human name shown on the agent board. |

`kind` describes the protocol, not the model:

- `anthropic` — the Anthropic API, or the Claude Code login the bridge already uses.
- `openai` — anything OpenAI-compatible: Ollama, vLLM, LM Studio, OpenAI itself.
- `remote` — a separate host running the standalone remote-agent package. HTTPS
  with a trusted certificate and a per-host bearer token is required. Only
  research and ops travel; see [Remote agent deployment](remote-agent.md).
- `gateway` — an Anthropic-compatible proxy. This is the only way a background
  agent can run on a model that is not Claude, because the agent SDK speaks the
  Anthropic API and the safety gate lives in its hooks. An `openai` endpoint
  therefore serves conversation and cheap summarising, never an agent task.

A malformed entry is dropped with a warning rather than taken as fatal, so one
mistyped host does not cost you the others. Endpoints are probed for
reachability and an unreachable one is skipped for a minute; a `401` counts as
reachable, because that is a wrong key to fix rather than a dead host to avoid.
With `JARVIS_ENDPOINTS` unset, `JARVIS_LOCAL_URL` and `JARVIS_LOCAL_MODEL`
synthesise a single endpoint called `local`, exactly as before.

## Background Agents

| Variable | Default | Purpose |
|---|---|---|
| `JARVIS_AGENTS` | disabled | Set to `1` in the bridge environment to expose agent tools. |
| `JARVIS_AGENTS_TOKEN` | required | Shared bearer token for the bridge and agent service. |
| `JARVIS_AGENTS_PORT` | `8788` | Agent service port. |
| `JARVIS_AGENTS_HOST` | `127.0.0.1` | Address the service binds. Anything other than loopback requires the TLS pair below, or the service refuses to start. |
| `JARVIS_AGENTS_TLS_CERT` | none | PEM certificate chain. Set with the key to serve HTTPS. |
| `JARVIS_AGENTS_TLS_KEY` | none | PEM private key. Read from disk at startup, never held in the environment. |
| `JARVIS_AGENTS_TLS_CA` | none | PEM CA bundle. Enables mutual TLS; current remote-dispatch clients do not present client certificates. Do not set it on a worker receiving remote tasks. |
| `JARVIS_HOST_LABEL` | the machine's hostname | How this host names itself on another host's board. |
| `JARVIS_AGENTS_DIR` | `~/.config/jarvis/agents` | Persistent goals, tasks, and event state. |
| `JARVIS_WORK_DIR` | `~/.jarvis-work` | Worker workspaces. |
| `JARVIS_AGENTS_SONNET` | `claude-sonnet-5` | Default agent-worker model. |
| `JARVIS_AGENTS_OPUS` | `claude-opus-5` | Higher-reasoning worker model. |
| `JARVIS_REMOTE_WORKERS` | `1` | Standalone remote runtime worker capacity, clamped from one to eight; keep the main endpoint concurrency at or below it. |

| `JARVIS_MAX_WORKERS` | sum of endpoint capacity, at least `3` | Hard ceiling on workers running at once across the whole pool. |

Total worker capacity is the sum of the `concurrency` values of the `anthropic`
and `gateway` endpoints in `JARVIS_ENDPOINTS`, under the `JARVIS_MAX_WORKERS`
ceiling — set that when a generous endpoint list would spawn more local
processes than this machine can bear. Declare no endpoints and behaviour is
unchanged: three workers against the Anthropic API. `GET /endpoints` on the
agent service reports each endpoint's health, in-flight count and capacity, and
the agent board shows the same.

A task runs on an `anthropic` endpoint unless its `model` names an endpoint id,
so local capacity is used deliberately rather than by accident — the coordinator
pins the work it judges cheap enough.

Generate and store the shared token with `npm run agents:token`. See
[Background agents](background-agents.md) for startup instructions.
