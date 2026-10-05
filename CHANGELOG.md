# Changelog

All notable changes to JARVIS Refined are recorded here, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project is not yet versioned, so entries are grouped by date.

Each entry goes under **Unreleased** in one of: Added, Changed, Fixed, Removed,
Security. When work is committed, move its entries under a dated heading.

## 2026-10-05

### Added

- Small Windows repair installers update the shared setup helpers without
  replacing application archives or the existing uninstaller. The deployment
  guide tracks fixes and verification needed for the next full installer build.
- A production launcher serves the built interface and local bridge without
  running the development server, with read-only actions by default.
- Release packaging builds an isolated WSL application payload without local
  environment files, and the Linux service installer supports production builds.
- Windows installer sources provision a dedicated WSL distro, resume setup after
  reboot, register per-user startup and browser-relay tasks, and retain WSL data
  on uninstall. Windows release validation is still required.
- Windows installers can be compiled on Linux using an isolated Wine container
  and a checksum-pinned Inno Setup compiler.
- The README has a Requirements section listing the runtime, browser, model
  provider and optional speech credentials needed before installing.

### Fixed

- Windows setup shows WSL provisioning progress as it happens, with credentials
  redacted, instead of appearing frozen during long steps.
- Windows setup relaunches into native 64-bit PowerShell so WSL remains
  accessible when setup or shortcuts start from a 32-bit process.
- WSL provisioning explicitly selects Jarvis's own systemd bus instead of
  inheriting another user's session address during service setup and lifecycle commands.
- Windows provisioning gives Jarvis ownership of its config and systemd
  directories, including repairing directories created by earlier previews.
- Windows setup reports the failing provisioning step and saves redacted logs,
  and WSL availability checks handle native errors before requesting setup.
- Windows release packaging works when temporary build files and the output
  directory are on different filesystems.
- Kokoro speech uses a quantized CPU model in a background worker to avoid UI
  freezes and competition with the interface's graphics rendering.

## 2026-10-04

### Added

- Confirmation prompts before deleting an individual session or clearing all
  past sessions.
- Development diagnostics identify the scripts responsible for long UI freezes.

### Fixed

- Reduced unnecessary audio-level updates and LCARS console rendering, and skip
  post-processing when the scene has nothing to draw.

### Changed

- Push-to-talk mutes Jarvis's microphone input between presses, without changing
  the system microphone or affecting other applications.
- Session recall ranks search results by relevance, ignores filler words, and
  matches on any search word rather than requiring all of them.
- Reading a long past conversation shows its opening and closing turns, with an
  optional turn range for the middle.
- Finished conversations get one-line summaries, stored beside the history file.

## 2026-10-03

### Added

- Local conversation history and voice input.
- Chat attachments (images and PDFs), session history panel, and theme refinements.
- Per-provider model selection and cache-friendly prompts.
- Theme screenshots in the documentation.

### Fixed

- UI memory retention and graphics dependency compatibility (three pinned to r182).
- Bridge reconnection and detection of stale WebSocket sessions.

### Changed

- Clarified deployment and safety documentation.

## 2026-10-02

### Added

- Tool timeline, LCARS command windows, and searchable command palette.
- LCARS personal status report.

### Changed

- Interface themes refactored into self-contained packages.
- LCARS theme styling and reactor visualization refreshed.

## 2026-10-01

### Added

- Remote agent deployment and endpoint orchestration.
- Background agents spread across a pool of LLM endpoints.
- Full-up service installer (`scripts/install.sh`).
- Prominent push-to-talk status in both HUDs.

### Security

- Hardened remote dispatch retry and token handling.

## 2026-09-30

### Added

- Push-to-talk and session agent board.
- Remote browser relay support.
- ORIN console theme.

### Fixed

- Duplicate spoken announcements.

## Earlier

Changes before 2026-09-30 are recorded only in the git history (`git log`).
