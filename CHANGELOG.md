# Changelog

All notable changes to JARVIS Refined are recorded here, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project is not yet versioned, so entries are grouped by date.

Each entry goes under **Unreleased** in one of: Added, Changed, Fixed, Removed,
Security. When work is committed, move its entries under a dated heading.

## Unreleased

### Added

- One settings file, `~/.config/jarvis/config.toml`, holds every non-secret
  setting in `[frontend]` (compiled into the browser) and `[bridge]` sections;
  credentials stay in `~/.config/jarvis/secrets.env`. Credential-looking or
  unknown keys in `config.toml` are ignored with a warning. `.env.local` still
  loads as the lowest-priority fallback. Migrate with
  `node scripts/migrate-config.mjs [--retire]`; see `config.example.toml`.
  `scripts/install.sh` and the Windows provisioning now write `config.toml`
  instead of `service.env` (an existing `service.env` is migrated), the
  launchers load it, `.env.example` is now the secrets template, and the
  direct-mode `model`, `fast_mode` and extra MCP servers
  (`[[frontend.mcp_servers]]`) are configurable there.
- The LCARS Loose ends list can manually close an entry and persist the change
  to the local ledger.

### Changed

- Agent tasks and chat sessions can no longer write generated files anywhere in
  the home folder. Writes outside `~/.jarvis-work` are limited to `~/Projects`
  (plus `JARVIS_PROJECT_ROOTS`); other home paths now need approval for agent
  shell commands and are refused for file tools. Restart the bridge and
  `jarvis-agents` to apply it.

### Added

- Agent profiles can select from the skills installed under `~/.claude/skills`.
  The profile editor lists each installed skill with its description and
  pre-ticks what the profile already chose. Selections are stored by skill name
  (the skill's directory name), never by path, and profiles saved before this
  load with nothing selected. Saving a name that is not installed is refused and
  the message says which one; a selected skill that is later uninstalled keeps
  loading and stays editable, shown as **(missing)** until it is unticked. The
  agent service gains an authenticated `GET /skills` route returning ids, names
  and descriptions only — no filesystem paths leave the machine. Running the
  profile records the selection on the goal, and every worker on that goal gets
  those skills' instructions appended to its system prompt, read from disk as
  each task starts so an edited skill applies to the next run. A skill that has
  been uninstalled or cannot be read is logged and skipped rather than failing
  the run; instructions are injected in name order; and the block is capped at
  20,000 characters per skill and 60,000 together. A profile with no skills
  selected gets exactly the prompt it did before. Restart `jarvis-agents` and
  the bridge to apply it.

- A themed file browser (Files button, Shift+F, command palette) lists the files
  agents have written under `~/.jarvis-work/goals/*/tasks`, with in-panel
  preview of text, images and PDF, download, and deletion. Deleting requires
  writes to be enabled and is refused for files of queued or running tasks.
  The `sessions` folder, hidden files and folders, and `node_modules` are never
  listed or served, nor reachable through symlinks; HTML and SVG preview as
  plain text. Restart the bridge to enable it.

- The agent board now has searchable task history and expandable full results,
  saved text report previews, refresh controls and report downloads, including
  older completed or archived tasks. Report reads stay inside each task's report
  folder; missing files and oversized previews show an error without losing results.

- Blocked tasks now have a board reply field to supply missing information and
  resume a paused goal. Chat and voice can look up goals and blockers by title
  without asking you for internal IDs.

- Scheduled tasks can save their own Claude, OpenAI, or configured local provider
  and model, used for both planning and workers independently of chat. OpenAI
  and local workers use the existing tool approval policy and time/turn limits;
  dollar-budget caps remain Claude-only.

- The Agents window now shows current and saved work together in Waiting,
  Working, Paused and Idle groups, with status-colored rows, concise goal/agent
  labels and a highlighted selection, plus reusable profiles. Goals can be
  paused, resumed or stopped; decision blockers use validated multiple-choice
  forms, and the detail focuses on results, decisions and related files rather
  than listing worker task plans.

### Fixed

- JARVIS and background agents can edit files throughout the owning user's home
  folder without workspace approval; credential paths and destructive actions
  keep their separate protections.
- Background agents load the same project-local provider configuration as chat,
  so configured OpenAI and local models are available in the task scheduler.
- Agent approval cards show the exact requested command and when it was raised;
  workers are instructed to keep command logs inside their workspace.
- Editing a scheduled task now opens its form below that task instead of above
  the list.

### Changed

- JARVIS chat and agents now organize generated output under `.jarvis-work`,
  grouped by session or goal/task with reports, artifacts, logs and temporary
  folders. Chat responses and worker reports are saved automatically; file
  tools reject loose output elsewhere while preserving project edits. Existing
  files and task paths are left in place.

- LCARS buttons now use one consistent square, red-cap design across the command deck, composer, scheduler and other panels, with shared state colours and keyboard focus styling.
- Scheduler buttons in the LCARS panel now have square corners and evenly sized red edge bars.
- Scheduler action buttons now share consistent sizing and show text labels beside their icons.
- Scheduler buttons now match the command operations panel's 40px height and red-cap spacing.

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
