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

## Session history and recall

Session history (**Shift+H**) lists past conversations. It is stored in this
browser's local storage and keeps session text, timestamps, tool names and
attachment names/metadata, not attached file bytes.

Click a past session to continue it. **New session** saves the current conversation
and starts an empty one. The last active conversation and transcript are restored
when the interface loads; an explicitly started empty session stays empty on reload.
Loading a session does not submit a model request or repeat previous actions.
Newer sessions link
to their bridge conversation checkpoint; older sessions restore the recorded
dialogue. Reopening does not execute old requests or restore attached file bytes.

The browser tab keeps its current conversation ID in session storage. The bridge
saves private recovery checkpoints under `~/.config/jarvis/conversations`
(override with `JARVIS_CONVERSATIONS_DIR`), and Claude keeps its native session
transcripts in its own configuration directory. Reconnects, reloads and bridge
restarts recover conversation context; interrupted actions are not automatically
replayed. If a native Claude transcript is missing, the dialogue checkpoint is
used instead. Checkpoints contain conversation text and use owner-only file
permissions. They and Claude's native transcripts are retained separately from
the history list; deleting a history entry does not delete these recovery files.

A copy of the session text (not tool names or attachment metadata) is also
mirrored to the local bridge at `~/.config/jarvis/sessions.json` (override with
`JARVIS_HISTORY_FILE`; up to 200 sessions, owner-readable only). JARVIS reads it
with the `history_recent`, `history_search` and `history_read` tools, so he can
recall in detail what was said in earlier sessions on the local device. These tools are read-only and
are available even when writes are disabled. Deleting a session in the History
view removes it from the copy too.

Jarvis does not have access to session history stored on other devices you used to access him.

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

### Run without a relay window

The standalone downloaded relay supports background operation with the same
Node runtime and no additional installation. On Windows, start it once:

```powershell
node .\jarvis-relay.mjs wss://dockerbox:5173/bridge/relay --token <token> --ca .\jarvis.crt --background
```

After the command reports that it is running, close the terminal. The child
Node process is detached with Windows console hiding enabled; its command line
does not contain the relay token. Certificate and socket options continue to
work. Prefer a trusted certificate; `--insecure` is still supported only for
networks you trust.

```powershell
node .\jarvis-relay.mjs --status
node .\jarvis-relay.mjs --stop
```

Status distinguishes a linked relay from one reconnecting to the server. A
second background start is rejected; stop the existing relay before changing
servers or credentials. The background relay reconnects after network loss,
but does not automatically restart after a process crash, logout, or reboot.
Run the start command again in those cases. Foreground operation is unchanged.

Logs and private control state live in `%LOCALAPPDATA%\JarvisRefined\Relay` on
Windows, or `~/.local/state/jarvis-relay` on Linux and macOS. The token is passed
through the child environment, not saved in this state. Files are restricted to
the current user (and SYSTEM on Windows); local administrators can still inspect
processes. `relay.log` rotates at approximately 5 MiB, keeping one previous log.
Use `--background-dir <path>` on start, status, and stop to select a separate
directory. Preserve access to Node and the downloaded script for later commands.

That machine needs Chrome open with the Claude extension, and Claude Code
installed with its Chrome integration enabled. The bridge drives the browser of
the machine the interface was opened from; with a single relay connected and no
browser on the server, that relay is used for every session. Use `--insecure`
instead of `--ca` only on a network you trust: the relay hands the bridge your
signed-in browser.
