# Windows Installer Development

For end-user installation, follow the [Windows 0.0.11 setup tutorial](windows-setup.md).

The first implementation targets **x64 Windows 10 22H2 (build 19045) and
Windows 11**, using the dedicated Ubuntu 24.04 WSL2 distro named `Ubuntu-24.04`.
It is an installer development preview, not a tested or signed Windows release.
Windows 10 installation support does not imply Microsoft servicing support;
operators must account for their edition's support lifecycle and security updates.

## Implemented

- A production frontend and bridge launcher, with same-origin `/bridge` routing,
  HTTP/WebSocket forwarding, media ranges and static-file boundary checks.
- Isolated application packaging, built with bridge mode and no developer
  `.env` files or Vite/provider environment overrides.
- SHA-256 verification of the bundled application and installer helpers.
- Pre-install checks for current WSL2, the dedicated `Ubuntu-24.04` distro, and
  Node.js 22+ installed system-wide in both Windows and Ubuntu.
- Dedicated-distro provisioning, systemd user services, per-install tokens and
  initial read-only mode. Other WSL distros are not changed.
- Per-user runtime and browser-relay tasks, shortcuts, diagnostics and explicit
  stop commands. Setup does not install or update WSL, Ubuntu or Node.js.
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

The application archive is bundled in the Windows installer. WSL, Ubuntu and
both Node.js runtimes are external prerequisites and are never downloaded or
modified by setup. The manifest lists these requirements and marks the bundled
application payload complete.

## Build the Installer Input

The installer input contains the application archive and setup scripts; it does
not contain WSL, an Ubuntu rootfs or Node.js archives. No separate prerequisite
downloads or hashes are supplied to the packaging command.

```bash
npm run package:windows -- \
  --output /path/to/new-installer-input
```

The builder writes an integrity manifest and copies the Windows installer
sources into `installer/`. Provisioning needs internet access to install the
Ubuntu system packages required by Jarvis.

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
No signing credentials are supplied here.

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

### Current Full Preview: 0.0.11

The full 0.0.11 installer was regenerated from the current checkout on 2026-10-06.
It includes the cumulative ownership, D-Bus, native PowerShell, live wizard log,
prerequisite checks and manifest-array lookup fixes. No separate repair is needed.
The user reported that repair 0.0.10 appeared to work; the freshly built full
0.0.11 installer still needs its own Windows end-to-end acceptance test.

`Downloads/JarvisRefined-Full-0.0.11/output/JarvisRefined-Setup-0.0.11-x64.exe`

The executable is 640,153,104 bytes (about 611 MiB), with SHA-256:

```text
34c34046872b61e120ee180b4a034e3cb7b96d5b43183a0671d59dc1766bb485
```

The [user setup tutorial](windows-setup.md) is distributed beside the executable
with a checksum sidecar and configuration reference. The payload bundles the
application and dependencies but not WSL, Ubuntu or either Node runtime. Build,
installer regressions, full tests and manifest/source verification passed; lint
reported existing warnings. The executable remains unsigned and was compiled
with Inno Setup 7.1.0 in non-commercial mode; commercial distribution requires
appropriate compiler licensing.

### Previous Full Preview Build

The current full preview was rebuilt on 2026-10-05 from the current checkout
with the official Ubuntu 24.04.5 AMD64 WSL image and Node 24.21.0 Linux/Windows
x64 runtimes. Publisher SHA-256 manifests were checked before packaging. The
build includes the checkout's current working changes and is not a tagged release.

The installer and checksum sidecar are stored outside `dist/`, in the persistent
workspace `Downloads/` folder:

`Downloads/JarvisRefined-Full-0.0.8/output/JarvisRefined-Setup-0.0.8-x64.exe`

This previous build defaults to `C:\Program Files\JarvisRefined`, but it embeds
WSL and Node archives and can attempt WSL setup. It is not the prerequisite-first
installer described by the current source. The current source checks for WSL2,
`Ubuntu-24.04`, and Windows/Ubuntu Node 22+ before installing anything.

The executable is 969,714,207 bytes (about 925 MiB), with SHA-256:

```text
57b11209e1abb6fe24a53ede403a081c8489f39ff0452be2d9b6eacdc978734a
```

### Prerequisite-First Preview Build

The 0.0.9 preview was built from the current checkout into persistent workspace
Downloads. It includes the application archive and setup files, but no WSL or
Node runtime archives:

`Downloads/JarvisRefined-Prereq-0.0.9/output/JarvisRefined-Setup-0.0.9-x64.exe`

The executable is 639,814,131 bytes (about 611 MiB), with SHA-256:

```text
14655ac52bcb4a43b8f0a15b3f8d49e21061946b63b2069461568ae2704b92af
```

The repair-only executable is also available at
`Downloads/JarvisRefined-Prereq-0.0.9/output/JarvisRefined-Repair-0.0.9-x64.exe`.
Both branches compiled with Inno Setup 7.1.0 and the payload manifest hashes
verified. The preview is unsigned, compiled in Inno's non-commercial mode, and
has not yet passed an end-to-end Windows installation test.

Successful compilation and a verified checksum do not establish successful
Windows installation or full feature parity. Test on a Windows development
machine first. Expect signing/SmartScreen warnings and manual provider/extension
setup as described below.

## Installation and Configuration

Before running setup, install and verify these prerequisites yourself:

- Current WSL2, verified by `wsl --version` showing a WSL version.
- The dedicated Ubuntu 24.04 distro, installed with
  `wsl --install --distribution Ubuntu-24.04` and launched once.
- Windows Node.js 22 or newer, with `node.exe` available on `PATH`.
- Ubuntu Node.js 22 or newer, available system-wide in the dedicated distro.

Check the runtimes before setup:

```powershell
wsl --version
wsl --list --quiet
node --version
wsl -d Ubuntu-24.04 -u root --exec node --version
```

Install Node.js from its official distribution for Windows and install a
system-wide Node.js package in Ubuntu; Node 24 LTS is recommended. The installer
does not configure package repositories or change either runtime.

The installer checks all four requirements before installing or replacing
application files. It does not enable Windows features, update WSL, install a
distro, download Node.js or change personal WSL distros. Enable hardware
virtualization and resolve any Windows restart or enterprise-policy requirements
before starting setup. Run it as the same Windows account that owns the dedicated
Ubuntu distro; administrator approval is used for the Program Files install.

The default application directory is `C:\Program Files\JarvisRefined`. Runtime
files and logs that need write access stay under `%LOCALAPPDATA%\JarvisRefined`.

The main setup window displays step explanations, a moving progress indicator,
and the latest redacted setup log lines while provisioning runs. PowerShell and
browser-relay background consoles are hidden. Diagnostic files remain at
`%LOCALAPPDATA%\JarvisRefined\Install.log` and `Install-error.txt`.

After health checks pass, setup opens `http://localhost:<selected-port>` and
registers hidden per-user login tasks for the runtime and browser relay. The
selected port between 5173 and 5199 is saved to keep the browser origin stable
across restarts. There is no claim of unattended operation before Windows sign-in.

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

If full setup 0.0.9 fails with `The property 'linuxDistribution' cannot be found`,
the bootstrap reads the manifest prerequisite array incorrectly. Node and WSL
have passed their prerequisite checks; do not reinstall them or delete the distro.
Close the failed setup and run the helper-only repair against the same application
folder (normally `C:\Program Files\JarvisRefined`):

`Downloads/JarvisRefined-Repair-0.0.10/output/JarvisRefined-Repair-0.0.10-x64.exe`

The repair replaces setup helpers and retries provisioning using the existing
application archive. It is 2,164,326 bytes with SHA-256:

```text
5a5952a51cc631e3893a659d20d4b97574a58379d62d8ae33e531c0878a9cdee
```

The repair compiled successfully and passes the strict-mode manifest regression;
actual Windows installation remains an acceptance check. The original full 0.0.9
executable still contains the bug; future full builds use the corrected source.

If setup reports that `C:\Windows\System32\wsl.exe` is not recognized even though
WSL is installed, check whether PowerShell was started as a 32-bit process.
Windows redirects its `System32` lookups to the 32-bit system directory, where
WSL may not exist. The shared bootstrap now resolves the native system directory
and relaunches in 64-bit PowerShell before taking its installation lock.
Elevation and runtime tasks use the native PowerShell path. The prerequisite-first
installer does not restart Windows or resume a partially installed WSL setup.

The cumulative small `0.0.6` repair is available at
`Downloads/JarvisRefined-Repair-0.0.6/output/JarvisRefined-Repair-0.0.6-x64.exe`.
This fixes Windows PowerShell 5.1 stripping quotes from the inline JavaScript
previously passed to `node.exe -e`; the runtime is now checked via `node.exe
--version`, without shell-sensitive JavaScript arguments.
Use the same account and existing installation folder. It includes the prior
ownership, bus, native-PowerShell and progress fixes. The version-check test
passes in portable PowerShell; successful Windows setup remains to be confirmed.

If Linux preflight reports `mkdir: cannot create directory
'/home/jarvis/.config/systemd': Permission denied`, an earlier preview created
the `.config` parent as root. The Jarvis config subdirectory was user-owned,
but the parent did not allow the service user to create its systemd directories.
The revised provisioning explicitly owns all config/systemd directories as
`jarvis`, including repairing the earlier parent, without recursively changing
saved files.

That error was fixed in earlier `JarvisRefined` distro-based previews. The
current installer uses the dedicated `Ubuntu-24.04` distro and checks external
Node.js prerequisites before provisioning.

To repair that specific error on an older install, run in **Windows PowerShell**:

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
$dir = "$env:ProgramFiles\JarvisRefined"
powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass `
  -File "$dir\installer\bootstrap.ps1" -Action Install -InstallDir "$dir"
```

Set `$dir` to the actual installation folder if an older preview or custom
location was used.
The revised preview compiled and passed local syntax/native-error/report tests;
Windows setup success still requires verification on the affected PC.

The Start Menu includes Launch, Stop, Diagnostics and Configure commands.
The app and tokens live in the dedicated distro; Windows installer state and
the distro backing store live under `%LOCALAPPDATA%\JarvisRefined`.
The application and shortcuts live under `%ProgramFiles%\JarvisRefined`; setup
logs and per-user state live under `%LOCALAPPDATA%\JarvisRefined`. Windows
Node.js is an external prerequisite installed by the user, not a bundled runtime.

The uninstall entry stops the runtime, removes Jarvis login tasks and deletes
the Windows-side relay token, **but retains WSL data**. It does not uninstall WSL
or remove other distributions. Before uninstalling, optionally back up the distro:

```powershell
wsl --export Ubuntu-24.04 'D:\Backups\jarvis-refined.tar'
```

If complete data deletion is intended, run this **before removing installer
files**, after verifying a backup:

```powershell
& "$env:ProgramFiles\JarvisRefined\installer\bootstrap.ps1" `
  -Action RemoveData -ConfirmRemoveData `
  -InstallDir "$env:ProgramFiles\JarvisRefined"
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
| Require current WSL2, dedicated Ubuntu-24.04 and Windows/Ubuntu Node 22+ before any application file is installed | `deploy/windows/bootstrap.ps1`, `deploy/windows/jarvis.iss` | Prerequisite PowerShell regression and Inno full/repair fixture compilation; Windows acceptance pending |
| Bundle only the Jarvis application; never install WSL or bundle either Node runtime | `scripts/package-windows.mjs`, `deploy/windows/provision.sh` | Manifest contract, archive-option rejection, and Linux provisioning tests |
| Install application files in Program Files while running WSL setup as the original user | `deploy/windows/jarvis.iss` | Full and repair Inno branches compile; Windows user/UAC flow still needs end-to-end confirmation |
| Show per-setup redacted logs in the main wizard with step descriptions and progress | `deploy/windows/jarvis.iss`, `deploy/windows/bootstrap.ps1` | Both Inno branches compile; progress-channel source tests pass; Windows UI flow pending |
| Hide runtime/relay consoles and put writable Node files in Local AppData | `deploy/windows/bootstrap.ps1` | Source assertions and PowerShell parsing pass; Windows task/session behavior pending |
| Relaunch 32-bit setup hosts into native 64-bit PowerShell before locking; resolve WSL through the native system directory | `deploy/windows/bootstrap.ps1` | Architecture tests passed; confirmed on the affected PC (Stop step reached WSL) |
| Reject outdated/inbox WSL with actionable user instructions instead of installing/updating it | `deploy/windows/bootstrap.ps1` | Legacy output regression passes; Windows acceptance pending |
| Stream redacted WSL progress live instead of buffering until each command exits; announce long extraction/service steps | `deploy/windows/bootstrap.ps1`, `deploy/windows/provision.sh` | Streaming/redaction/capture-privacy test passed; Windows run pending |
| Validate the Windows Node runtime using `--version`; avoid inline JavaScript quotes altered by Windows PowerShell 5.1 | `deploy/windows/bootstrap.ps1` | Node 24 accepted and Node 20 rejected in the PowerShell regression test; Windows retry pending |
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

1. Run `npm test`, `npm run lint`, shell syntax checks and the Docker ownership/
  bus regressions. Enable the portable/Windows PowerShell tests where available.
2. Run `npm run package:windows` into a **new** output directory, with `TMPDIR`
  on a disk that has several GB free. This regenerates the application archive,
  embedded provisioning sources, external installer helpers and manifest from
  the latest reviewed checkout. Do not reuse an older application archive or
  compile an old `dist/.../installer` snapshot.
4. Compile the new output's `installer/jarvis.iss` with a new `ReleaseVersion`
  **without** defining `RepairOnly`. Verify executable format, record its
  checksum and return container-generated files to the build user's ownership.
5. Test a clean Windows install with all prerequisites already present and a
  retry of an existing partial install, including healthy bridge/frontend/agent
  services and preservation of other distros and saved state. Signing and full
  feature-parity checks remain release requirements.

The small `0.0.3` repair is at
`dist/windows-repair-20261005-bus/output/JarvisRefined-Repair-0.0.3-x64.exe`.
It updates only setup helpers and reuses an existing installation's verified
archives; it is not the next full build. Its SHA-256 is
`99af73ad0ee6c5ffddb6bf6f1c7060aff9a928754171afd5c04ac5ab93fe82f2`.

The full `0.0.7` installer built from the current source is at
`Downloads/JarvisRefined-Full-0.0.7/output/JarvisRefined-Setup-0.0.7-x64.exe`.
It is 969,540,145 bytes with SHA-256
`6b5491ce5f23e732df62c16b7ec090459fcfee8633da19316c06a2c04b29fa12`.
Both installer branches compile; a clean Windows installation with Program
Files elevation, original-user WSL registration and live wizard logging remains
to be tested.

The repository's Windows source-check workflow parses PowerShell and compiles
Inno Setup with **non-deployable fixtures**. It deliberately publishes no installer.
Linux tests cover the production HTTP/WebSocket boundaries, release filtering,
checksums and relay configuration.

Before shipping a full-parity installer, validate on actual Windows 10/11 hosts:

1. Install WSL2, Ubuntu-24.04 and both Node.js prerequisites first; test a clean
  setup with virtualization and policy failures, leaving personal distros untouched.
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