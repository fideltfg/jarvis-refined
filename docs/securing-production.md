# Securing JARVIS for Production

JARVIS acts on what it hears and reads. A misheard command, a prompt injected
through a web page, or an over-broad goal can make it overwrite or delete files.
This guide limits the damage by shrinking what the JARVIS process can touch and
making everything it can touch recoverable.

The principle: **assume JARVIS will eventually be wrong, and make being wrong
cheap.**

## What JARVIS can reach

| Surface | Default reach | Source |
|---|---|---|
| `jarvis_files` reads and searches | The owning user's whole home directory, the output root, the system temp directories, plus `JARVIS_FILE_ROOTS` | `bridge/server.mjs`, `bridge/files.mjs` |
| Foreground and background file writes | The owning user's home directory and task output roots; credential locations remain denied. Shell deletes/moves and external MCP tools are not confined to these roots. | [Output folders](background-agents.md#output-folders) |
| Writes | Blocked by `--readonly`; the service installer enables writes unless passed `--readonly` | [Tools and Safety](tools-and-safety.md) |
| Background-agent workspaces | `~/.jarvis-work/goals/<goalId>/tasks/<taskId>` (`JARVIS_WORK_DIR`); existing paths retained | [Background agents](background-agents.md) |
| Agent state | `~/.config/jarvis/agents` (`JARVIS_AGENTS_DIR`) | [Configuration](configuration.md) |
| Secrets | `~/.config/jarvis/secrets.env` | [Deployment](deployment.md) |
| MCP and shell-capable tools | Whatever the owning OS user can do | `~/.claude.json` |

The home directory is **always** a permitted root for file access, and
`JARVIS_FILE_ROOTS` can only add to it. JARVIS and its agents can edit ordinary
files throughout that home; credential paths and high-impact operations retain
separate checks. The practical boundary is therefore the OS account JARVIS runs
as, not an application setting. Do not run JARVIS as your everyday login.

## 1. Run as a dedicated, unprivileged user

Create an account that owns nothing except JARVIS:

```bash
sudo adduser --disabled-password --gecos "" jarvis
sudo loginctl enable-linger jarvis
```

- Never run as root, and give the account no `sudo` rights and no membership in
  the `docker` group (docker group access is root-equivalent).
- Do not run it as the account that holds your documents, projects, SSH keys, or
  other services' data. With your normal user, "home" includes all of that.
- Install JARVIS as that user (`./scripts/install.sh`). The installer refuses to
  run as root.

Resulting layout, all inside `/home/jarvis`:

```text
/home/jarvis/
  jarvis-refined/        code checkout (read-only at runtime, see below)
  .config/jarvis/        secrets.env, service.env, agents/ state, backups/
  .jarvis-work/          disposable agent workspaces
  workspace/             the only place JARVIS should create or edit your files
```

Put anything JARVIS must read from elsewhere in `workspace/` as a copy or a
read-only mount; do not point it at the original.

## 2. Keep read-only mode the default

```bash
./scripts/install.sh --readonly
```

The installer enables writes by default. Use it only when actions are intended,
then re-run it with `--readonly` to return to read-only mode:

```bash
./scripts/install.sh              # enable writes; restarts the services
./scripts/install.sh --readonly   # block writes; restarts the services
```

`--writes` is not an installer option. Run the HUD in read-only on any host
that is unattended, always-on, or in a room with other people talking.

## 3. Make the code and configuration read-only to JARVIS

If the process cannot modify its own checkout, a bad write cannot break the
service.

```bash
# as an administrator: the code belongs to a different owner
sudo chown -R root:jarvis /home/jarvis/jarvis-refined
sudo chmod -R g-w,o-rwx /home/jarvis/jarvis-refined
```

Then give the service write access only where it needs it. Because the tools
resolve symlinks and check the real path against the roots, a symlink pointing
out of a root does not grant access, but it also does not protect a file inside
one. Use ownership and mode bits, not symlinks, for protection.

Writable by the service: `~/.config/jarvis/`, `~/.jarvis-work/`, and
`~/workspace/`. If the Vite development server is used, its cache also needs
group write permission and a systemd writable-path exception; the recursive
checkout hardening above removes that permission, and `ReadOnlyPaths` below
would otherwise block it even if the mode bits allowed writes:

The bridge's file tools always include the service user's home directory as a
permitted root. JARVIS can read files there, including `~/.config/jarvis/secrets.env`,
even in read-only mode. With writes enabled, it can also write within that root.
File permissions do not isolate files from a process running as their owner;
systemd `ReadOnlyPaths` can block writes but not reads. Treat data and credentials
in this home as accessible to JARVIS, use only limited and revocable credentials,
and keep actions read-only except during supervised sessions.

```bash
sudo install -d -o root -g jarvis -m 2770 /home/jarvis/jarvis-refined/node_modules/.vite
sudo chown -R root:jarvis /home/jarvis/jarvis-refined/node_modules/.vite
sudo chmod -R g+rwX /home/jarvis/jarvis-refined/node_modules/.vite
```

Everything else should be read-only. Updating (`git pull`, `npm ci`) is then
done by an administrator, followed by `./scripts/install.sh`.

Protect secrets:

```bash
chmod 700 ~/.config/jarvis
chmod 600 ~/.config/jarvis/*.env ~/.config/jarvis/*.pem
```

## 4. Constrain the services with systemd

`install.sh` generates the units and replaces manual edits on the next run, so
add hardening as a drop-in, which survives re-runs:

```bash
systemctl --user edit jarvis
systemctl --user edit jarvis-agents
```

```ini
[Service]
NoNewPrivileges=yes
PrivateTmp=yes
ProtectControlGroups=yes
ProtectKernelTunables=yes
RestrictSUIDSGID=yes
LockPersonality=yes
# Read-only view of the checkout; writable only where listed.
ReadOnlyPaths=%h/jarvis-refined
ReadWritePaths=%h/.config/jarvis %h/.jarvis-work %h/workspace %h/jarvis-refined/node_modules/.vite
# Limit runaway resource use so a loop cannot take the host down.
MemoryMax=2G
TasksMax=512
CPUQuota=200%
```

```bash
systemctl --user daemon-reload
systemctl --user restart jarvis jarvis-agents
systemctl --user status jarvis jarvis-agents
```

Sandboxing options in user units depend on the host (user namespaces and
unprivileged systemd support). If a unit fails to start with a namespace error,
remove the failing directive rather than disabling the others, and rely on
sections 1, 3 and 5. After any change, run a voice turn and a read, a write
inside `workspace/`, and a refused write outside it to confirm the boundary.

`PrivateTmp=yes` also hides the real `/tmp` from the service; the bridge
accepts both, so panels that read screenshots written elsewhere to `/tmp` stop
appearing. Drop it if that matters.

## 5. Make data loss recoverable

Prevention fails eventually; recovery must not depend on JARVIS behaving.

**Back up from outside the JARVIS account.** A backup the same user can delete
is not a backup. Run it as a different user or on a different host, and keep at
least one copy the JARVIS account cannot write.

```bash
# /etc/cron.d or a root/other-user timer: read-only snapshot of the workspace
rsync -a --delete-after --link-dest=/backups/jarvis/latest \
  /home/jarvis/workspace/ /backups/jarvis/$(date +%F-%H%M)/
ln -sfn /backups/jarvis/$(date +%F-%H%M) /backups/jarvis/latest
```

Alternatives with the same property: filesystem snapshots (ZFS, btrfs, LVM),
`restic` or `borg` with an append-only repository, or an offsite copy.

**Use version control in `workspace/`.** For each project JARVIS edits, keep a
git repository and commit before a session. Review `git diff` after, and push
only from a human-controlled step. Do not give the JARVIS account credentials
that can force-push or delete branches.

**Back up configuration and state** (small, and costly to recreate):
`~/.config/jarvis/` (including `agents/`, `contacts.json`, and the installer's
`backups/`), excluding nothing secret from an encrypted backup.

**Test a restore** after setting up and after any major change. An untested
backup is a hope.

## 6. Limit what is exposed and who can reach it

- Keep the bridge (`8787`) and agent API on loopback. Use `/bridge` through the
  one HTTPS origin on a LAN, and never expose the development server to the
  internet ([Deployment](deployment.md)).
- Restrict the HTTPS port with the host firewall to the intended network.
- Do not set `JARVIS_ALLOW_NO_ORIGIN`, and keep `JARVIS_ALLOWED_ORIGINS` to exact
  origins you use.
- Do not use direct mode (`VITE_BACKEND=direct`) in production, because keys are
  readable by visitors.
- Keep API keys only in `secrets.env`, and use a key with a spend limit set at
  the provider so a runaway loop or misheard task cannot exhaust the account.
- Be sparing with `JARVIS_FILE_ROOTS`. Never add `/`, `/etc`, `/var`, `/home`, a
  mounted backup, or another user's data.
- Review `~/.claude.json` MCP servers. Any server that can run commands, send
  messages, or delete data widens the blast radius of a mistake regardless of
  the file roots.

## 7. Reduce accidental commands

Most accidents begin with audio JARVIS should not have acted on.

- Use push-to-talk, or mute the microphone, unless the room is private and quiet.
- A voice profile filters speakers only after you enroll it with **P** and read
  all five phrases. It is not authentication: no profile, a missing speaker
  model, or audio that is too short or cannot be analysed allows speech
  through. Prefer push-to-talk or mute when needed.
- Keep the approval flow on for background agents and review pending approvals
  before accepting them; do not auto-approve destructive categories.
- For goals that touch files, state the exact directory and say "do not delete".
  Prefer tasks that write new files over tasks that edit or replace existing
  ones.

## Production checklist

- [ ] JARVIS runs as a dedicated non-root user with no sudo and no docker group.
- [ ] That user's home contains only JARVIS data and the `workspace/` directory.
- [ ] Started with `--readonly`; writes enabled only when intended.
- [ ] Code checkout is not writable by the service.
- [ ] `~/.config/jarvis` is `700`; env and key files are `600`.
- [ ] systemd drop-in applied and the service starts cleanly.
- [ ] Resource limits set (`MemoryMax`, `TasksMax`, `CPUQuota`).
- [ ] Backups run from outside the JARVIS account, with one copy it cannot write.
- [ ] A restore has been tested.
- [ ] `workspace/` projects are under version control.
- [ ] Ports are bound to the intended interface and firewalled.
- [ ] `JARVIS_FILE_ROOTS` contains only the paths you intend.
- [ ] Provider API keys have spend limits.
- [ ] Push-to-talk is enabled, or an enrolled voice profile is used with its
  fail-open behavior for missing profiles, unavailable models, and short or
  unanalysable audio understood.

## Verify the boundary

As the service user, with writes enabled, ask JARVIS to:

1. Write a file in `~/workspace/` (should succeed).
2. Write a file in the checkout (should be refused by systemd when the
   `ReadOnlyPaths` restriction above is applied).
3. Write or read a path outside the home, system temporary directories, and
   configured `JARVIS_FILE_ROOTS` (should be refused by the roots check).

Do not test by exposing credentials. Reads under `~/.config/jarvis/` are
permitted, and writes there are possible when enabled and not blocked by the OS.

Then confirm the backup contains the file from step 1. Repeat after upgrades.
