# Providers and Voice

## Model Providers

The bridge can offer three provider types:

| Provider | Setup | Notes |
|---|---|---|
| Claude | Claude Code installed and logged in | Default provider; uses the existing Claude Code login. Default model is `JARVIS_MODEL`. |
| OpenAI | `OPENAI_API_KEY` on the bridge | Default model is `gpt-4.1-mini`; override with `OPENAI_MODEL`. |
| Local | Set `JARVIS_LOCAL_URL` and `JARVIS_LOCAL_MODEL`, or `JARVIS_ENDPOINTS` for several | Uses an OpenAI-compatible API, for example a local server exposing `/v1`. |

Choose an available provider in the HUD. `JARVIS_PROVIDER` sets the initial
provider for a new browser; the browser remembers its own selection. Provider
credentials stay on the bridge except in direct mode, which places the
Anthropic key in the browser and is intended only for local demos.

### Choosing a model

The **Model** menu beside the provider menu lists the models the selected
provider can run, with the default first. The bridge builds the list, so it can
only offer models that are configured on the bridge:

| Provider | Models offered | Configure with |
|---|---|---|
| Claude | `JARVIS_MODEL`, then `opus`, `sonnet`, `haiku` | `JARVIS_CLAUDE_MODELS` (comma-separated) replaces the extras. |
| OpenAI | `OPENAI_MODEL` | `JARVIS_OPENAI_MODELS` (comma-separated) adds more. |
| Local | Each distinct `model` in the endpoint pool | `JARVIS_LOCAL_MODEL`, or the `model` field of each `JARVIS_ENDPOINTS` entry. |

For example, to offer two Claude models and three OpenAI models:

```bash
JARVIS_MODEL=claude-opus-5
JARVIS_CLAUDE_MODELS=sonnet,haiku
OPENAI_MODEL=gpt-4.1-mini
JARVIS_OPENAI_MODELS=gpt-4.1,gpt-4o
```

Changes to these variables take effect when the bridge restarts.

How the choice behaves:

- The browser remembers one model per provider, so switching providers back
  and forth keeps each choice.
- The model is sent with every question; there is no separate apply step.
- Claude switches the model of the running session, so the conversation
  carries over rather than starting again.
- Choosing a Local model sends turns only to the endpoints that serve it. If
  several endpoints serve the same model, the turn can still move between them
  when one is at capacity.
- A provider with only one model shows the menu disabled.
- If a remembered model is no longer offered, the menu falls back to the
  provider's default.
- When failover moves a turn to another provider, it uses the model last picked
  for that provider.

When a provider hits a rate limit or runs out of credits before it has emitted
text or called a tool, the bridge can retry with another configured provider.
It does not automatically retry partial answers or tool actions. Switching
providers sends recent conversation text to the newly selected provider.

All providers share bridge-hosted tools and configured MCP services. Claude's
built-in tools and Anthropic-hosted web search are Claude-only; configure an MCP
search server when using OpenAI or Local. See the
[Configuration reference](configuration.md) for variable names and defaults.

## Speech Input

Local voice-activity detection identifies speech and enables barge-in: speaking
while JARVIS is talking interrupts playback. At startup, the browser checks
bridge capabilities and chooses the best configured transcription path:

1. ElevenLabs Scribe when the bridge has an ElevenLabs key.
2. OpenAI transcription when an OpenAI key is available.
3. The browser's `SpeechRecognition` implementation otherwise (Chrome/Edge).

No transcription-service key is required for the browser fallback. Browser
recognition availability and behavior depend on the browser.

## Speech Output

Kokoro is the default text-to-speech engine and runs in the browser using
single-threaded CPU/WASM inference in a background worker, keeping speech off
the UI thread and away from the graphics renderer's GPU. Its quantized model
is downloaded and cached by the browser on first use. Generation speed depends
on your CPU. Each
theme selects its own base voice and processing profile. If Kokoro is
unavailable, the app can use the operating-system speech voice. Set
`VITE_TTS_ENGINE=system` to choose browser speech synthesis directly.

ElevenLabs is optional. A bridge-side `ELEVENLABS_API_KEY` enables its voice and
Scribe transcription; `VITE_USE_ELEVENLABS=true` explicitly prefers cloud speech
output. The bridge can also read the key from the `elevenlabs` MCP server
configuration in `~/.claude.json`.
