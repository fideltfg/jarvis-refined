# Deployment Guide

JARVIS has two required processes—the browser frontend and bridge—and one
optional background-agent service. Choose the smallest layout that meets your
needs.

| Layout | Best for | Transport | Important setting |
|---|---|---|---|
| Same-machine development | Personal use and development | HTTP + WebSocket on loopback | Defaults work |
| LAN browser | A phone/tablet or another computer opens the HUD | HTTPS + proxied secure WebSocket | `JARVIS_HOST`, TLS pair, `VITE_BRIDGE_URL` |
| Built frontend | Testing optimized assets | Static files plus a separately running bridge | Runtime must still reach the bridge |
| Background service | Goals that survive browser/bridge restarts | Authenticated loopback HTTP by default | `JARVIS_AGENTS=1` and token |
| Services at boot | An always-on host | systemd user units | `scripts/install.sh` |
| Remote worker | Sending research to another model host | Authenticated HTTPS | `JARVIS_ENDPOINTS` remote entry |

## Same-machine development

```bash
npm install
npm run start:readonly
```

The frontend listens on port `5173` and the bridge on `8787`. Use `PORT` and
`JARVIS_BRIDGE_PORT` to change them; if you choose a frontend port outside the
trusted development ranges, add its exact origin to `JARVIS_ALLOWED_ORIGINS`.

## LAN browser with HTTPS

Browsers allow microphones on `localhost` or a secure origin. To open the HUD
from another device, give Vite a certificate valid for the hostname clients use
and expose it on the LAN:

```bash
JARVIS_HOST=0.0.0.0 \
JARVIS_TLS_CERT=/path/to/fullchain.pem \
JARVIS_TLS_KEY=/path/to/private-key.pem \
VITE_BRIDGE_URL=/bridge \
npm run start:readonly
```

`/bridge` uses Vite’s same-origin proxy, so the HTTPS page reaches the local
bridge as a secure WebSocket without exposing bridge port `8787`. Trust the
certificate on the client device and allow the Vite port through the firewall
only on the intended network. Do not expose the development server directly to
the public internet.

When setting a full URL instead, use `wss://`, make it reachable from the client,
and add the page’s exact origin to `JARVIS_ALLOWED_ORIGINS`. Never enable
`JARVIS_ALLOW_NO_ORIGIN` merely to work around an origin error.

## Production frontend build

```bash
npm run build
npm run preview
```

`npm run build` writes optimized static assets to `dist/`; `npm run preview` is
a local preview, not a hardened production server. A real static host must serve
the built files over HTTPS and route the configured bridge WebSocket. Vite
variables are compiled into the bundle at build time: rebuild after changing a
`VITE_*` value, and never place private credentials in a public build.

Direct mode (`VITE_BACKEND=direct`) can produce a frontend-only deployment, but
its Anthropic key and any direct-mode MCP tokens are readable by every visitor.
It is suitable only for a private, local demonstration. Bridge mode is the
recommended deployment because secrets stay server-side.

## Background-agent service

The agent service is optional and separate from the bridge. Generate its token,
start it, then enable the bridge client as described in
[Background agents](background-agents.md). To run it (and the bridge) as
services that start at boot, use the installer below rather than copying unit
files by hand.

## Run as services at boot (`scripts/install.sh`)

`scripts/install.sh` installs, enables and starts the bridge + face and the
agent service as systemd **user** units, and makes them start at boot. It
enables writes by default; pass `--readonly` to block effectful actions:

```bash
./scripts/install.sh              # actions allowed (same as npm start)
./scripts/install.sh --readonly   # actions blocked (same as npm run start:readonly)
```

Run it as the user who will own JARVIS, not root, from a normal login (not via
`su`/`sudo`). It needs Node.js 20+ (`~/.local/node/bin/node` is preferred,
otherwise `node` on `PATH`) and systemd.

What it does, in order:

1. **Preflight** — checks the checkout, Node and the user systemd manager, and
   enables *linger* (`loginctl enable-linger`) so user services start at boot
   without a login. If that needs privileges it stops and asks you to run
   `sudo loginctl enable-linger $USER` once.
2. **Dependencies** — runs `npm ci` only when `node_modules` is missing or
   older than `package-lock.json`.
3. **Token** — runs `scripts/agents-token.mjs`; an existing token is kept.
4. **Service environment** — creates `~/.config/jarvis/service.env` if missing
   and ensures `JARVIS_AGENTS=1` so the bridge uses the agent service.
5. **Units** — writes `jarvis-agents.service` and `jarvis.service` to
   `~/.config/systemd/user/`, verifies them, then enables and restarts both.
6. **Health checks** — waits for the agent API, the bridge `/health` endpoint
   and the face port, and confirms neither service crash-restarted.

It is safe to re-run (for example after `git pull` or to change the action
mode): files that already match are left alone, nothing is appended twice, and
the services are restarted to pick up new code and mode. The installer accepts
`--readonly`, not `--writes`; omitting the switch enables writes.

### Files and paths

| Path | Purpose |
|---|---|
| `~/.config/systemd/user/jarvis.service` | Bridge + face (`scripts/start.mjs`). Starts after the agent service. |
| `~/.config/systemd/user/jarvis-agents.service` | Background-agent service (`agents/service.mjs`). |
| `~/.config/jarvis/service.env` | Host settings for both units: `JARVIS_HOST`, `JARVIS_TLS_CERT`/`KEY`, `JARVIS_ALLOWED_ORIGINS`, ports, `JARVIS_AGENTS`. |
| `~/.config/jarvis/secrets.env` | Tokens and keys (unchanged location). |
| `~/.config/jarvis/backups/<timestamp>-<pid>/` | Copies of any file a run replaced. |

Changes from the earlier hand-installed units:

- The units are **generated** with the real checkout path and Node binary, so
  the checkout no longer has to live at `%h/jarvis-refined`.
  `deploy/jarvis-agents.service` remains only as a reference.
- Host-specific `Environment=` lines no longer belong in the unit files. On
  first run, settings from a hand-written `jarvis.service` are migrated into
  `service.env`. Edit `service.env` and re-run the installer (or
  `systemctl --user restart jarvis jarvis-agents`) to change them; manual edits
  to the unit files are replaced on the next run.
- Both units load `secrets.env` first and `service.env` second, so a value in
  `service.env` wins.

### Failure and rollback

If any step fails, the script prints the step, the error and the failing
unit's recent log lines (with tokens redacted), then rolls back this run:

- every file it replaced is restored from the backup directory, and files it
  created are removed;
- each unit's previous enabled/running state is restored;
- linger is disabled again if this run enabled it.

Backups are taken only when a file actually changes and are kept after a
successful run, so a re-run that changes nothing creates none. Dependencies
installed by `npm ci` are not rolled back.

### Operating the services

```bash
systemctl --user status jarvis jarvis-agents
journalctl --user -u jarvis -u jarvis-agents -f
systemctl --user restart jarvis jarvis-agents
```

To remove them:

```bash
systemctl --user disable --now jarvis jarvis-agents
rm ~/.config/systemd/user/jarvis.service ~/.config/systemd/user/jarvis-agents.service
systemctl --user daemon-reload
sudo loginctl disable-linger "$USER"   # only if nothing else needs it
```

Keep the agent API on loopback unless you deliberately configure its TLS
certificate and key. A routable bind without TLS is rejected.

## Remote model workers

Use a standalone remote runtime when the task itself should run on a separate
host. It accepts only research and ops tasks and requires HTTPS plus a unique
bearer token. Follow [Remote agent deployment](remote-agent.md); do not deploy
the `remote-runtime/` source directory by itself.

## Deployment checklist

- Keep `.env.local`, token files, certificate private keys, and issued archives
  out of version control.
- Use `npm run start:readonly` until action behavior has been reviewed.
- Bind only the ports and interfaces the chosen layout requires.
- Use a certificate valid for the hostname clients actually open.
- Prefer `/bridge` on a LAN so one secure origin covers the UI and WebSocket.
- Verify health and an end-to-end voice turn after every configuration change.
- Run `npm test`, `npm run lint`, and `npm run build` before packaging a release.
