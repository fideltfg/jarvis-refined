# Tools and Safety

JARVIS can use MCP services configured for Claude Code in `~/.claude.json`, as
well as tools supplied by its bridge. The available external services depend on
the machine; common examples include search, image generation, phone control,
and browser automation. Account connectors configured only in claude.ai are not
read from that account by the local bridge.

## Action Gate

The bridge blocks effectful operations such as sending, clicking, typing,
deleting, installing, or paying unless writes are enabled. The read-only
commands are `npm run bridge` and `npm run start:readonly`; `npm run
bridge:writes`, `npm start`, and an installed service without `--readonly`
enable writes. The bridge owns this policy; user Claude Code permission
settings cannot override it.

Enable writes only for a session where actions are intended:

```bash
npm run bridge:writes
# or, with the combined launcher:
npm start -- --writes
```

For systemd services, `./scripts/install.sh` enables writes by default and
`./scripts/install.sh --readonly` blocks them. Re-run the installer with the
desired mode to update and restart the service; `--writes` is not an installer
option. See [Deployment](deployment.md#run-as-services-at-boot-scriptsinstallsh).

Treat voice requests as real actions. When writes are enabled, a broad request
can have effects outside the HUD. The background-agent workers use their own
tool policy and approval flow; see [Background agents](background-agents.md).

### Voice profile limits

Pressing **P** only opens the voice-profile workflow. To enable speaker
filtering, explicitly enroll by reading all five prompted phrases; the profile
is stored locally in this browser. It is a convenience filter, not
authentication or a security boundary: without an enrolled profile, or when
the speaker model is unavailable or a segment is too short or cannot be
analysed, verification allows the segment through. Use push-to-talk or mute the
microphone when commands from other voices would be unsafe.

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

## Browser control from another machine

The `chrome_*` tools reach the Claude extension through a socket on the machine
Chrome runs on. When the bridge runs on a server, run the relay on each machine
whose browser JARVIS should drive:

```bash
npm run relay:token        # on the server, once; then restart the bridge
```

```bash
# on the machine with Chrome (Node 22+, one file, no install)
# For a private/self-signed CA, use the trusted CA certificate here.
curl --cacert jarvis.crt -O https://<server>:5173/jarvis-relay.mjs
node jarvis-relay.mjs wss://<server>:5173/bridge/relay --token <token> --ca jarvis.crt
```

If the server certificate chains to a CA already trusted by the machine, use
`curl -O` and omit `--ca` from Node. Never use `curl -k` for executable code:
the Node `--ca` option verifies only the later WebSocket connection, not the
download.

That machine needs Chrome open with the Claude extension, and Claude Code
installed with its Chrome integration enabled. The bridge drives the browser of
the machine the interface was opened from; with a single relay connected and no
browser on the server, that relay is used for every session. Use `--insecure`
instead of `--ca` only on a network you trust: the relay hands the bridge your
signed-in browser.
