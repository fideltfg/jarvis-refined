# Windows Installer Development

The first implementation targets **x64 Windows 10 22H2 (build 19045) and
Windows 11**, using a dedicated Ubuntu 24.04 WSL2 distro named `JarvisRefined`.
It is an installer development preview, not a tested or signed Windows release.
Windows 10 installation support does not imply Microsoft servicing support;
operators must account for their edition's support lifecycle and security updates.

## Implemented

- A production frontend and bridge launcher, with same-origin `/bridge` routing,
  HTTP/WebSocket forwarding, media ranges and static-file boundary checks.
- Isolated application packaging, built with bridge mode and no developer
  `.env` files or Vite/provider environment overrides.
- SHA-256 verification of explicitly supplied Ubuntu and Node archives.
- Dedicated-distro provisioning, systemd user services, per-install tokens and
  initial read-only mode. Other WSL distros are not changed.
- Resumable WSL prerequisite setup, per-user runtime and browser-relay tasks,
  shortcuts, diagnostics and explicit stop commands.
- Uninstall detaches Jarvis and retains its WSL data. Data deletion is a separate,
  explicitly confirmed operation.

The frontend runs in the Windows browser, so microphone, camera, WebGL and
speech use Windows devices directly, not Linux audio passthrough. The backend
and shell commands run in Linux. WSL resource readings are not Windows host
readings. Individual MCP integrations still need their own accounts, dependencies
and hardware; USB/device passthrough is not automatically provisioned.

## Build the Application Payload

On Linux x64 with a compatible Node release (Node 24 LTS recommended):

```bash
npm run package:windows
```

The default output is `dist/windows-installer/`. An existing output directory is
never overwritten: select another with `--output <new-directory>` or remove a
previous disposable build yourself. Source is built in a temporary clean staging
directory with `npm ci`, including MediaPipe WASM and theme discovery assets.
The archive includes production dependencies and the Linux bridge/agent runtime.
It includes current working-tree source, including uncommitted changes: review
the checkout before making a release. No credentials migrate from your Linux PC.
Kokoro/speaker model downloads and external provider services still need network
access unless separately preprovisioned; this is not an offline installer.

Without prerequisite artifacts, the manifest says `complete: false`. This
application-only build cannot install Windows and is not a release executable.

## Build a Complete Installer Input

Obtain an official **Ubuntu 24.04 x64 WSL rootfs in uncompressed `.tar` format**,
a supported **Node Linux x64 `.tar.xz`**, and matching **Node Windows x64 `.zip`**.
Verify publisher provenance and checksums independently before supplying them;
a matching locally supplied hash alone does not establish publisher trust.
Both Node runtimes must be version 22 or newer and compatible with the locked
application dependencies; use a tested Node 24 LTS version for a release.

```bash
npm run package:windows -- \
  --output /path/to/new-installer-input \
  --rootfs /path/to/ubuntu-24.04-wsl.tar --rootfs-sha256 <publisher-verified-hash> \
  --linux-node /path/to/node-linux-x64.tar.xz --linux-node-sha256 <publisher-verified-hash> \
  --windows-node /path/to/node-win-x64.zip --windows-node-sha256 <publisher-verified-hash>
```

All three archives and their hashes are required together. The builder writes
an integrity manifest and copies the Windows installer sources into `installer/`.
The rootfs must have no configured accounts, credentials or machine-specific
services. Provisioning needs internet access for Ubuntu prerequisite packages.

On a Windows build machine with **Inno Setup 6.4 or later**, compile the inputs:

```powershell
& 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' `
  '/DPayloadDir=C:\build\jarvis-installer-input' `
  '/DReleaseVersion=0.0.0' `
  'C:\build\jarvis-installer-input\installer\jarvis.iss'
```

The resulting executable is placed in the input directory's `output/` folder.
Assign a real release version and Authenticode-sign the executable using your
release certificate before distribution. A signature authenticates the installer
and its embedded manifest; the hashes are integrity checks, not signatures.
No signing credentials or completed rootfs/runtime bundle are supplied here.

### Compile on Linux

An isolated Wine/Inno Setup container can compile the same inputs without
installing Wine on the host:

```bash
docker build --load --progress plain -t jarvis-inno-compiler:7.1.0 \
  -f deploy/windows/Dockerfile.compiler deploy/windows
docker run --rm --network none \
  --mount type=bind,source=/absolute/path/to/installer-input,target=/work \
  jarvis-inno-compiler:7.1.0 \
  '/DPayloadDir=Z:\work' '/DReleaseVersion=0.0.0' \
  'Z:\work\installer\jarvis.iss'
```

The compiler runs directly without a display wrapper; its installation step
uses a virtual display. The image verifies the official Inno Setup 7.1.0
compiler archive's pinned checksum. Inno Setup 7's non-commercial compiler mode
is used here; commercial use requires the appropriate compiler licensing.
The container runs as root, so return generated output ownership to the build
user before writing additional files:

```bash
docker run --rm --network none --entrypoint /bin/chown \
  --mount type=bind,source=/absolute/path/to/installer-input,target=/work \
  jarvis-inno-compiler:7.1.0 "$(id -u):$(id -g)" \
  /work/output /work/output/JarvisRefined-Setup-0.0.0-x64.exe
```

### Local Preview Build

An unsigned preview was compiled on 2026-10-04 with the official Ubuntu 24.04.5
AMD64 WSL image and Node 24.21.0 Linux/Windows x64 runtimes. Publisher SHA-256
manifests were checked before packaging. The current checkout, including its
uncommitted changes, was used; this is not a tagged release.

The generated files are under
`dist/windows-installer-20261004/output/JarvisRefined-Setup-0.0.0-x64.exe`
and its `.sha256` sidecar. These ignored build artifacts are not committed.
The executable is 968,147,117 bytes (about 923 MiB), with SHA-256:

```text
c7df027f644eb03a818a0f83ce009aa3162ce687bcc47eef9c2ea55147133c81
```

Successful compilation and a verified checksum do not establish successful
Windows installation or full feature parity. Test on a Windows development
machine first. Expect signing/SmartScreen warnings, possible WSL prerequisite
approval/reboot, and manual provider/extension setup as described below.

## Installation and Configuration

The installer runs as the Windows user who will use Jarvis. It requests UAC
approval only for WSL prerequisites. Enabling virtualization features may require
a Windows restart; setup registers a per-user resume command for the next sign-in.
Firmware virtualization must already be enabled, and enterprise policies may
prevent WSL installation. Do not run the entire installer under another Windows
administrator identity: WSL registration and configuration are per-user.

After health checks pass, setup opens `http://localhost:<selected-port>` and
registers login tasks for the runtime and browser relay. The selected port
between 5173 and 5199 is saved to keep the browser origin stable across restarts.
There is no claim of unattended operation before Windows sign-in.

**Provider and integration onboarding is not yet automated.** The Configure
Jarvis shortcut opens the dedicated Linux user's shell. Set provider keys and
settings in `~/.config/jarvis/secrets.env` and `service.env`; do not put secrets
in frontend build variables. For Claude, install the official Claude Code CLI
as that Linux user, complete its login and configure MCP servers there:

```bash
npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code
"$HOME/.local/bin/claude"
systemctl --user restart jarvis jarvis-agents
```

Browser control additionally requires Windows Chrome with the Claude extension
and a Windows Claude Code native host enabled for Chrome integration. The
packaged relay supports Windows named pipes, but actual extension discovery is
still a Windows acceptance gate; installing a relay does not install the extension.
The relay token is kept in a user-ACL-protected file, never in scheduled-task
arguments. Microphone/camera/extension permission prompts remain user-approved.

The initial application is read-only. To enable real actions after configuration:

```bash
cd /opt/jarvis-refined/current
bash scripts/install.sh --production
```

To return to read-only mode, append `--readonly`. Existing background-worker
policies and approval requirements remain unchanged.

Windows files are mounted under `/mnt/c`. Add only approved directories to
`JARVIS_FILE_ROOTS`, using Linux paths, then restart the bridge. Do not give the
assistant unrestricted access to the Windows drive by default. LAN UI and remote
worker access require explicit HTTPS, certificate trust, WSL networking and
firewall configuration; setup does not open inbound firewall ports.

Remote endpoints retain their existing capabilities and restrictions: the
standalone remote worker is text-only, does not operate services/browser/commands,
and currently blocks ops tasks. Installing a standalone Windows worker role,
Windows host telemetry/control adapters and device passthrough are not yet
automated by this bootstrap.

## Lifecycle and Removal

### Provisioning Failures

If setup reports that `C:\Windows\System32\wsl.exe` is not recognized even though
WSL is installed, check whether PowerShell was started as a 32-bit process.
Windows redirects its `System32` lookups to the 32-bit system directory, where
WSL may not exist. The shared bootstrap now resolves the native system directory
and relaunches in 64-bit PowerShell before taking its installation lock. Resume,
elevation and runtime tasks use the native PowerShell path.

The cumulative small `0.0.4` repair is available locally at
`dist/windows-repair-20261005-native/output/JarvisRefined-Repair-0.0.4-x64.exe`.
Use the same account and existing installation folder. It retains the earlier
ownership and bus fixes. Architecture-selection tests pass locally; a real
32-to-64-bit handoff regression is enabled only on Windows. Successful setup on
the affected PC is still required.

If Linux preflight reports `mkdir: cannot create directory
'/home/jarvis/.config/systemd': Permission denied`, an earlier preview created
the `.config` parent as root. The Jarvis config subdirectory was user-owned,
but the parent did not allow the service user to create its systemd directories.
The revised provisioning explicitly owns all config/systemd directories as
`jarvis`, including repairing the earlier parent, without recursively changing
saved files.

To repair that specific error on an existing install, run in **Windows PowerShell**:

```powershell
wsl.exe -d JarvisRefined -u root --exec chown jarvis:jarvis /home/jarvis/.config
$dir = "$env:LOCALAPPDATA\Programs\JarvisRefined"
powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass `
  -File "$dir\installer\bootstrap.ps1" -Action Install -InstallDir "$dir"
```

Set `$dir` to the chosen installation folder if different. The ownership command
changes only the parent directory, not its contents. Do not use recursive
world-writable permissions or run the Jarvis service itself as root.
The `0.0.2` preview includes the automatic ownership repair and is available
locally at
`dist/windows-installer-20261005-permissions/output/JarvisRefined-Setup-0.0.2-x64.exe`.
It remains unsigned and has not completed Windows end-to-end validation.

The original `0.0.0` preview showed a generic "Jarvis provisioning failed"
dialog that hid the actual failing step. A revised `0.0.1` diagnostic preview is
available locally at
`dist/windows-installer-20261004-diagnostics/output/JarvisRefined-Setup-0.0.1-x64.exe`.
It handles native WSL probe failures explicitly, uses its bundled bootstrap for
repair preflight, and displays the saved failure detail. The original Linux
application and verified prerequisite archives are unchanged. This is a candidate
repair, not confirmation of the cause of a particular Windows failure.

Run `0.0.1` using the same Windows user and installation folder. Do not unregister
the distro or remove its state to troubleshoot. If setup still fails, read:

```powershell
Get-Content "$env:LOCALAPPDATA\JarvisRefined\Install-error.txt"
```

The report includes the failing step, message and log path. The append-only
`Install.log` records stage details and redacted WSL output. Prerequisite elevation
has a separate `EnableWsl.log` under the elevated user's local application data;
alternate administrator credentials may therefore put that log in another user
profile. Log and report files have restricted user/SYSTEM ACLs. Review diagnostic
text before sharing it; do not send provider keys or tokens.

To see the original `0.0.0` script's error in a window that stays open, or retry
the installed bootstrap directly:

```powershell
$dir = "$env:LOCALAPPDATA\Programs\JarvisRefined"
powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass `
  -File "$dir\installer\bootstrap.ps1" -Action Install -InstallDir "$dir"
```

Set `$dir` to the actual installation folder if a custom location was selected.
The revised preview compiled and passed local syntax/native-error/report tests;
Windows setup success still requires verification on the affected PC.

The Start Menu includes Launch, Stop, Diagnostics and Configure commands.
The app and tokens live in the dedicated distro; Windows installer state and
the distro backing store live under `%LOCALAPPDATA%\JarvisRefined`.
The executable files live under `%LOCALAPPDATA%\Programs\JarvisRefined`.

The uninstall entry stops the runtime, removes Jarvis login tasks and deletes
the Windows-side relay token, **but retains WSL data**. It does not uninstall WSL
or remove other distributions. Before uninstalling, optionally back up the distro:

```powershell
wsl --export JarvisRefined 'D:\Backups\jarvis-refined.tar'
```

If complete data deletion is intended, run this **before removing installer
files**, after verifying a backup:

```powershell
& "$env:LOCALAPPDATA\Programs\JarvisRefined\installer\bootstrap.ps1" `
  -Action RemoveData -ConfirmRemoveData `
  -InstallDir "$env:LOCALAPPDATA\Programs\JarvisRefined"
```

Linux application provisioning preserves the previous release and restores it
when Linux installation/health checks fail. Complete installer upgrade rollback,
automatic updates and an interactive onboarding wizard are not yet implemented.
Treat setup re-runs as development repair, not a proven production update path.

## Validation Gates

### Fix Ledger for the Next Full Build

Full and repair builds share `deploy/windows/bootstrap.ps1`,
`deploy/windows/provision.sh` and `deploy/windows/jarvis.iss`. Fix these canonical
sources, not just an already-generated `dist/` input directory. The user's
requirement is to carry every installer repair into subsequent full builds.

| Fix | Source | Verification |
| --- | --- | --- |
| Relaunch 32-bit setup hosts into native 64-bit PowerShell before locking; resolve WSL through the native system directory | `deploy/windows/bootstrap.ps1` | Architecture tests passed; confirmed on the affected PC (Stop step reached WSL) |
| Stream redacted WSL progress live instead of buffering until each command exits; announce long extraction/service steps | `deploy/windows/bootstrap.ps1`, `deploy/windows/provision.sh` | Streaming/redaction/capture-privacy test passed; Windows run pending |
| Serve a built frontend with local bridge routing instead of Vite | `scripts/serve.mjs`, `scripts/install.sh --production` | HTTP/WebSocket/security tests and isolated payload smoke passed |
| Publish release inputs across different filesystems | `scripts/package-windows.mjs` | Cross-filesystem regression passed |
| Make root-owned release binaries readable/executable by the service user, but not writable | `deploy/windows/provision.sh` | Directory/file-mode reproduction passed |
| Check WSL native exit codes without losing the original failure | `deploy/windows/bootstrap.ps1` | Portable PowerShell native-error tests passed; Windows 5.1 remains an acceptance gate |
| Save redacted, step-specific failure reports and show them in setup | `deploy/windows/bootstrap.ps1`, `deploy/windows/jarvis.iss` | Report/redaction tests and Inno compilation passed |
| Use the new bundled bootstrap during repair preflight | `deploy/windows/jarvis.iss` | Inno full/repair branch compilation passed |
| Own config parents and systemd directories as `jarvis` | `deploy/windows/provision.sh` | Reported Windows mkdir failure reproduced and repaired in a container; user retry passed that step |
| Select the target user's runtime directory and D-Bus address for all user commands | `deploy/windows/provision.sh`, `run_as_owner()` | Wrong-inherited-address regression passed; Windows bus-error retry still pending |
| Small helper-only repairs preserve the existing payload and uninstaller | `deploy/windows/jarvis.iss`, `RepairOnly` | Actual repair executable and full-branch fixture compiled; Windows execution pending |

Before the next **full** executable build:

1. Collect the Windows retry result for the bus error and incorporate any further
  fixes into the same canonical sources. Do not call a locally tested candidate
  a confirmed Windows fix before that retry succeeds.
2. Run `npm test`, `npm run lint`, shell syntax checks and the Docker ownership/
  bus regressions. Enable the portable/Windows PowerShell tests where available.
3. Run `npm run package:windows` into a **new** output directory with the verified
  rootfs and both Node archives, with `TMPDIR` on a disk that has several GB free
  (a small `/tmp` memory filesystem fails with a quota error). This regenerates the application archive,
  embedded provisioning sources, external installer helpers and manifest from
  the latest reviewed checkout. Do not reuse an older application archive for
  the next full release or compile an old `dist/.../installer` snapshot.
4. Compile the new output's `installer/jarvis.iss` with a new `ReleaseVersion`
  **without** defining `RepairOnly`. Verify executable format, record its
  checksum and return container-generated files to the build user's ownership.
5. Test both a clean Windows install and a retry of an existing partial install,
  including reboot/resume, healthy bridge/frontend/agent services and preservation
  of other distros and saved state. Signing and full feature-parity checks remain
  release requirements.

The small `0.0.3` repair is at
`dist/windows-repair-20261005-bus/output/JarvisRefined-Repair-0.0.3-x64.exe`.
It updates only setup helpers and reuses an existing installation's verified
archives; it is not the next full build. Its SHA-256 is
`99af73ad0ee6c5ffddb6bf6f1c7060aff9a928754171afd5c04ac5ab93fe82f2`.

The repository's Windows source-check workflow parses PowerShell and compiles
Inno Setup with **non-deployable fixtures**. It deliberately publishes no installer.
Linux tests cover the production HTTP/WebSocket boundaries, release filtering,
checksums and relay configuration.

Before shipping a full-parity installer, validate on actual Windows 10/11 hosts:

1. Clean WSL installation, administrator approval, reboot/resume and virtualization
   failures; existing personal distros must remain untouched.
2. Paths with spaces/non-ASCII characters, repeat setup, concurrent setup, port
   conflicts, partial install failures and uninstall with retained data.
3. Login, sleep/resume, Windows restart, manual WSL shutdown and relay reconnection.
4. All themes/graphics, voice/wake word, camera gestures, attachments and history.
5. Provider login/local models, MCP integrations, browser native-host discovery,
   background agents/approvals and remote research endpoints.
6. Read-only action rejection, file-root enforcement, credential ACLs, origin and
   token rejection, TLS verification and optional LAN networking.

No successful Windows runtime validation or full feature-parity claim is implied
by a Linux payload build or a syntax-only CI job.