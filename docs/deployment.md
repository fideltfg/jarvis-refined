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
[Background agents](background-agents.md). The supplied
`deploy/jarvis-agents.service` is a **user** systemd unit and assumes:

- the checkout is at `%h/jarvis-refined`;
- Node is at `%h/.local/node/bin/node`;
- secrets are in `%h/.config/jarvis/secrets.env`.

Adjust those paths before installing the unit. Keep the API on loopback unless
you deliberately configure its TLS certificate and key. A routable bind without
TLS is rejected.

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
