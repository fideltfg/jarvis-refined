# Tools and Safety

JARVIS can use MCP services configured for Claude Code in `~/.claude.json`, as
well as tools supplied by its bridge. The available external services depend on
the machine; common examples include search, image generation, phone control,
and browser automation. Account connectors configured only in claude.ai are not
read from that account by the local bridge.

## Action Gate

The bridge is read-only by default. Read and lookup operations can run, while
effectful operations such as sending, clicking, typing, deleting, installing, or
paying are denied unless writes are enabled. The bridge owns this policy; user
Claude Code permission settings cannot override it.

Enable writes only for a session where actions are intended:

```bash
npm run bridge:writes
# or, with the combined launcher:
npm start -- --writes
```

Treat voice requests as real actions. When writes are enabled, a broad request
can have effects outside the HUD. The background-agent workers use their own
tool policy and approval flow; see [Background agents](background-agents.md).

## Files and Network Boundaries

The shared `jarvis_files` tools can read text, list directories, search below
permitted roots, and write only when writes are enabled. The home directory and
system temporary directory are included; add further roots with
`JARVIS_FILE_ROOTS`. Requests outside permitted roots are rejected.

The bridge checks WebSocket origins against local development origins by
default. Add a trusted origin with `JARVIS_ALLOWED_ORIGINS`; do not enable
`JARVIS_ALLOW_NO_ORIGIN` casually. The bridge's file and media routes validate
paths and URLs, restrict private and loopback network targets, and apply size or
content limits to reduce traversal and SSRF risk.

## HUD Content

Model-authored panel HTML is sanitized with DOMPurify, a class allowlist, and a
strict Content Security Policy. Remote panel images and media are fetched by the
bridge rather than directly by the browser. These controls reduce exposure; do
not treat generated panel content or web pages as trusted instructions.

Keep API keys in the bridge environment. Only `VITE_` settings are included in
the frontend build. In particular, `VITE_ANTHROPIC_API_KEY` is exposed to the
browser in direct mode and should not be used for a shared or public deployment.
