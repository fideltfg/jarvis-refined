# Changelog

All notable changes to JARVIS Refined are recorded here, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project is not yet versioned, so entries are grouped by date.

Each entry goes under **Unreleased** in one of: Added, Changed, Fixed, Removed,
Security. When work is committed, move its entries under a dated heading.

## Unreleased

## 2026-10-07

### Added

- Recurring task schedules with interval and calendar triggers, a task scheduler
  window, and tools to create, update, pause, delete, and run schedules.
- Conversation recovery checkpoints and a session-history workflow for reviewing
  and reopening past conversations.
- A Loose ends command window for viewing unfinished-work records.
- Standalone browser relay background operation, status checks, and stop controls.
- Project-local grilling skills for reviewing plans and design decisions.

### Changed

- Startup speech gives a brief overview of running work, schedules, outstanding
  items, and issues instead of reading the entire detailed report aloud. The
  displayed report has clear sections, status labels, readable dates, and
  expandable progress notes and result paths.
- All agents are JARVIS agents regardless of provider: the agent board shows owner, provider/endpoint, model, goal, type, start time and brief for every live agent; agent-service tasks record the endpoint and model they run on; LCARS agent counts include every running agent, not only session subagents; the `status` tool combines agent-service goals with running session subagents.

### Fixed

- Bridge turns report progress and recover more reliably from interruptions,
  timeouts, and closed streams.
- Late browser speech-recognition results no longer duplicate an utterance or
  interrupt its answer.
- The `jarvis_agents` tools are wired back into the bridge for Claude, OpenAI and local providers when `JARVIS_AGENTS=1`.
- Session subagents are tracked once per bridge instead of per connection, so every window sees them and history writes no longer overwrite each other; subagents left running by a closed connection are marked interrupted.

## 2026-10-04

### Added

- Startup agent briefings are spoken as well as displayed. Speech waits for
  ignition to unlock browser audio and for the foreground conversation to be
  idle, without adding briefing turns to chat history.
- Confirmation prompts before deleting an individual session or clearing all
  past sessions.
- Development diagnostics identify the scripts responsible for long UI freezes.

### Fixed

- Startup reports now read authoritative task, goal, schedule, remote endpoint,
  subagent, personal-task, and unfinished-work records instead of asking a model
  to infer them. Completed work, last progress, results, and unavailable sources
  are reported explicitly; live subagents are not mistaken for interrupted history.
- Startup briefing visuals now use the HUD's mounted report surface rather
  than the legacy panel list, so progress and results are actually visible.
- Restored Loose ends command-window docking and ledger styling, with a
  scrollable list and responsive status/date alignment inside the session area.
- Hidden startup agent checks now start after page-load conversation recovery,
  without waiting for ignition or microphone access, and show checking, failure,
  and empty-result states instead of leaving no visible report.
- Restored task scheduler styling and LCARS command-window docking so the
  scheduler fills the session area instead of appearing unstyled at its bottom.
- Reduced unnecessary audio-level updates and LCARS console rendering, and skip
  post-processing when the scene has nothing to draw.

### Changed

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
