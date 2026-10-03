# Deploy a standalone remote agent

The coordinator runs on the main JARVIS host. A remote host runs a **separate,
minimal runtime package**, not a checkout of `jarvis-refined`. The package
contains the local model worker, scheduler, persistent task store and narrow delegated
API; no frontend, bridge, browser relay or coordinator. Remote dispatch carries
only research and ops tasks. Code and admin tasks remain on the main host.

The first release is built from this repository; it is not a separate repository
or a published npm package. The package has no npm runtime dependencies.
Installation requires root privileges, Node.js 20+ at `/usr/bin/node`, OpenSSL,
systemd and a local OpenAI-compatible model server bound to loopback. No Claude login, API
key, paid provider, or external model connection is required. The main host
retrieves reports through the remote runtime's authenticated HTTPS API. Do not
copy the coordinator's secrets file or browser profile. An ops task has no
external MCP integrations in this runtime;
it cannot operate the main host's services.

## Build and transfer (main host)

```sh
npm run package:remote
npm run issue:remote -- remote-host.lan
scp dist/remote-host.lan.tar.gz dist/remote-host.lan.tar.gz.sha256 remote-host.lan:/tmp/
```

Use the actual DNS name the main host uses to reach the remote. The issuer
creates a unique self-signed TLS certificate and bearer token for that host,
with its private key **only in the host-specific archive**, not in the generic
package or the main host's endpoint configuration. The archive and token file
are mode `0600`. Transfer only over SSH with a verified host key, never publish
the archive, and do not commit it. Keep `dist/remote-host.lan.cert.pem` on the
main host as the trust anchor and `dist/remote-host.lan.token` as a secret.
Store backups only in encrypted, access-controlled storage. Reissuing requires
replacing both the remote certificate and main-host trust and token settings.
Review the archive before distribution: it includes the current working tree's
packaged sources. The generic package contains a lockfile, not `node_modules`.

## First-run install (remote host)

Run these **on the remote host** with an administrator account. This is an
explicit privileged install, not a process that silently gains root access.
The model name must match one served by the on-host OpenAI-compatible server:

```sh
cd /tmp
sha256sum -c remote-host.lan.tar.gz.sha256
tar -tzf remote-host.lan.tar.gz  # Inspect the archive before extraction.
umask 077
tar -xzf remote-host.lan.tar.gz
sudo sh jarvis-remote-agent/remote-runtime/install.sh '<local-model-name>'
sudo systemctl status jarvis-remote-agent
rm -rf jarvis-remote-agent remote-host.lan.tar.gz remote-host.lan.tar.gz.sha256
```

The installer creates the restricted service account, state directories, TLS
files and service config, installs the package into a timestamped versioned
directory under `releases/`, points `current` at it, and enables systemd. This
is true on the initial install too. The installer refuses to overwrite an
existing install. The optional
second installer argument sets a different numeric-loopback `/v1` model URL;
the default is `http://127.0.0.1:11434/v1`. Check the local model server before
installing. Do not set
`JARVIS_AGENTS_TLS_CA` in this release: that enables mutual TLS, but the remote
dispatch client does not yet present client certificates. HTTPS with normal
certificate validation and a per-host bearer token is supported. Restrict
inbound port 8789 to the main host with a firewall; the supplied unit binds
all interfaces unless you change it to a private address.

## Connect and verify (main host)

Install `dist/remote-host.lan.cert.pem` where the main agent service can read it
and set `NODE_EXTRA_CA_CERTS` to that file in its environment. Put the token
from `dist/remote-host.lan.token` into the main service's protected environment
as `REMOTE_HOST_TOKEN`; do not put the token in a shell command or endpoint JSON.
Add the remote entry alongside existing endpoints:

```json
{ "id": "remote-host", "kind": "remote", "baseURL": "https://remote-host:8789",
  "concurrency": 1, "kinds": ["research", "ops"], "apiKeyEnv": "REMOTE_HOST_TOKEN" }
```

If you already declare `JARVIS_ENDPOINTS`, add this object to that JSON array;
otherwise create an array with just this remote entry for provider-free agent
work. Restart the **main agent service**, not just the
browser or bridge, after changing its environment. Confirm the remote certificate
is trusted and that the main host can query `/endpoints` with its token; an
unauthenticated request must return 401. Do not use `curl -k`. Check the agent
board for the remote endpoint. Run a small research task pinned to its id, then
check completion and event logs on both hosts. Local model access must be
checked independently of the HTTPS health probe.

The remote text-only worker has no actions requiring approval. Results are
returned to the main host through its authenticated task API; no model requests
are sent to the main host or an outside provider.

## Upgrade, rollback and limits

Do not rerun `install.sh` to upgrade: it intentionally refuses to overwrite an
existing install. Stop the service, unpack a newly built and checksum-verified
archive into a **new versioned directory**, install locked dependencies there
and atomically repoint `current`; then restart and repeat the health and task checks. Preserve
`/var/lib/jarvis-remote-agent` across releases. For rollback, stop the service,
repoint `current` to the previous tested directory, restart and verify. Do not
replace a directory in place while a worker is running; drain tasks first.
Remote work interrupted by a restart is recovered from persistent state, but
check the task board before upgrades.

Keep this host isolated and grant the service account only necessary access.
The remote runtime uses a text-only local model worker: it cannot browse,
run commands, or operate services. Ops tasks return blocked until explicitly
implemented. Keep concurrency at one unless the remote service's
`JARVIS_REMOTE_WORKERS` is also raised (maximum eight).
