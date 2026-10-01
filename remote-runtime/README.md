# Standalone remote agent runtime

This folder is built into a deployable package by `npm run package:remote` at the
repository root. The remote host needs **only** the resulting package, Node.js
20 or newer, and a local OpenAI-compatible model server on loopback. It needs
no provider login or paid API. The main JARVIS host retrieves results over the
runtime's authenticated HTTPS API; the remote never sends work to a provider.
It does not need this repository, the bridge, a browser, or frontend dependencies.
The package includes its own `package.json`, lockfile and first-run installer.
On the main host, `npm run issue:remote -- <remote-hostname>` adds a per-host TLS
certificate and key to a restricted deployment archive. See
[Remote agent deployment](../docs/remote-agent.md) for the install and trust
steps. Do not deploy this source folder alone: it imports shared worker modules
assembled by the packaging script.
