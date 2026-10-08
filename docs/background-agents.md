# Background Agents

Background agents let JARVIS turn multi-step requests into persistent goals and
tasks while the user continues the conversation. This subsystem is optional and
disabled unless both its service and the bridge connection are configured.

## Start the Service

The agent API listens on loopback port `8788` by default and requires a shared
bearer token. Generate the token once:

```bash
npm run agents:token
```

This stores `JARVIS_AGENTS_TOKEN` in
`~/.config/jarvis/secrets.env` with restricted file permissions. For manual
terminal use, load that file in both the agent-service and bridge environments.
In Bash, start each process in its own terminal:

```bash
set -a; . ~/.config/jarvis/secrets.env; set +a
npm run agents
```

```bash
set -a; . ~/.config/jarvis/secrets.env; set +a
JARVIS_AGENTS=1 npm start
```

To run the agent service and the bridge under systemd and start them at boot,
use `./scripts/install.sh`. It generates the token, sets `JARVIS_AGENTS=1` in
`~/.config/jarvis/service.env`, and installs both units; see
[Run as services at boot](deployment.md#run-as-services-at-boot-scriptsinstallsh).
Configure the service port and state paths with the variables in the
[Configuration reference](configuration.md).

### Letting another machine reach the service

By default the service binds `127.0.0.1` and nothing on the network can see it.
The bearer token is as good as your own hands on the machine, so the service
will not start on a routable address in plaintext: set `JARVIS_AGENTS_HOST` to
anything but loopback and it refuses unless `JARVIS_AGENTS_TLS_CERT` and
`JARVIS_AGENTS_TLS_KEY` are also set.

Serve HTTPS with a certificate valid for the host name. Set
`JARVIS_AGENTS_TLS_CA` when you require mutual TLS; clients without a certificate
signed by that CA are rejected during the handshake. Remote dispatch accepts
HTTPS only, and the connecting host must trust the server certificate. TLS 1.3
is the floor. The current remote-dispatch client does not present client certificates, so do
not enable mutual TLS on a host intended for remote dispatch. Use a trusted
certificate, a distinct bearer token per remote host and a firewall allow-list.
See [Remote agent deployment](remote-agent.md) for a complete install and
verification procedure.

A self-signed pair can work on a home network if its certificate is explicitly
trusted by the sender. Generate one that names the
host, and keep the key readable only by the service user:

```bash
openssl req -x509 -newkey rsa:4096 -nodes -days 825 \
  -keyout ~/.config/jarvis/agents-key.pem \
  -out ~/.config/jarvis/agents-cert.pem \
  -subj "/CN=jarvis-agents" \
  -addext "subjectAltName=DNS:$(hostname),IP:$(hostname -I | awk '{print $1}')"
chmod 600 ~/.config/jarvis/agents-key.pem
```

## Workflow

When the interface loads, JARVIS automatically requests a briefing on
previous session subagents and background or remote agent work. It waits for
conversation restoration and runs once per page launch, not on reconnects or
history changes, without waiting for ignition or microphone access. Startup
work uses a separate hidden session, leaving the
restored conversation's context and chat history untouched. The finished report
appears after ignition in a sticky Startup Agent Briefing panel with progress, completed
results, failures, interruptions, blockers, and pending approvals. The panel
shows when the check is running and reports failures or empty responses. JARVIS
also speaks a brief overview once ignition has unlocked browser audio and
the foreground conversation is idle. A report that arrives before ignition or
during another answer is queued; it does not interrupt or enter chat history.
The visual report groups work into sections with status labels and readable
dates. Detailed progress, result paths, and historical notes remain available
in expandable Details entries rather than being read aloud.
The report is formatted directly from a read-only service snapshot, not inferred
by a language model. It includes active and completed goals, archived tasks,
latest recorded progress and results, scheduled work and next runs, endpoint
health, session subagents, personal tasks, and the unfinished-work ledger.
It cannot create work, restart tasks, or approve actions. Saved subagent records
are distinguished from live tracking, schedules are not counted as workers, and
unavailable sources are reported explicitly rather than treated as empty.
This requires the bridge backend; background status tools additionally require
the agent-service configuration described above.

Ask JARVIS to handle work that takes more than one turn, such as a code change,
research report, service operation, or administrative task. The coordinator
plans tasks, schedules workers against the available capacity, tracks progress,
and reviews task results. Goals can be paused, resumed, updated with new
information, or abandoned. The `goal_create` interval option starts recurring
work immediately; use the task scheduler below to save work for a future time.

The `jarvis_agents` tools are available to every conversation provider: Claude,
OpenAI and local endpoints all hand work to the same agent service, so every
agent belongs to JARVIS whichever model asked for it. The agent board shows
main tasks (goals), each with one consolidated coordinator result. Worker and
session-subagent outputs are not listed individually. Worker blockers and
approval requests remain visible when they require your action. Agent counts
still include all workers and session subagents. The `status` tool
reports goals and running session subagents in one briefing. A session subagent
still running when its browser connection closes is marked interrupted.

Worker categories are `code`, `research`, `marketing`, `ops`, and `admin`.
Marketing workers research software positioning and draft evidence-based
campaign materials in their task workspace; they cannot publish or contact
prospects. Workers have per-task turn, time, and spending limits. Work is persisted under
`~/.config/jarvis/agents`; task workspaces use `~/.jarvis-work` by default.
Completed task workspaces can be removed with JARVIS's `cleanup` agent tool.

### Recall Results and Reports

Open the agent board and select **History** to retrieve older goals and tasks,
including completed, cancelled and archived work. Search matches main task
names, statuses and consolidated summaries. **Current** retains the live board;
**Refresh history** reloads the saved snapshot without launching work.

Each main task has one **Result** section containing its saved coordinator
summary, not individual worker outputs. Missing summaries are stated explicitly.
Expand **Files** under the result to see supported text documents grouped by
worker, from their `reports/` and `artifacts/` folders. **View** opens the document in
a readable blade; Markdown gets headings, lists, tables and code formatting,
JSON is indented, and HTML is sanitized before display. Other text is shown in
a code-style block. **Download** saves each file directly. **Refresh reports**
reloads the list. The viewer supports Markdown, text, JSON, CSV, HTML, XML,
YAML and log files, with a 512 KB per-file preview limit and up to 200 files.

Recall requires the bridge and agent service. If a workspace was cleaned up,
the recorded result remains available but its report files do not. Session
subagent summaries are not shown as main results; this file viewer is for persistent
agent-service tasks only. Reading history or reports never resumes tasks or
changes approval decisions.

## Output Folders

JARVIS keeps generated output under `~/.jarvis-work` (`JARVIS_WORK_DIR`), shared
by chat and the agent service. Set the same override in both services, and on
each remote worker if you use remote dispatch. New work uses this layout:

```text
.jarvis-work/
  sessions/<conversation-id>/
    reports/       latest.md: latest completed chat response or failure
    artifacts/     deliverables, downloads, screenshots, exports
    logs/          reports.jsonl: timestamped response history
    tmp/           intermediate files and shell temporary directory
  goals/<goal-id>/tasks/<task-id>/
    reports/       latest.md: latest progress, completion or blocker report
    artifacts/     task deliverables, grouped by project or topic
    logs/          reports.jsonl: every worker report call
    tmp/           intermediate files and shell temporary directory
```

Code tasks still use a git worktree at their task path. Agents are instructed
not to commit generated output folders unless they are requested project
deliverables. Existing task paths and previously scattered files are not moved;
resumed tasks gain the output subfolders at their existing path. Explicit
workspace cleanup also removes the task's saved output, so retain needed
deliverables before requesting cleanup.

Every worker report call and completed chat response is saved automatically.
Worker model messages are also retained in `logs/worker.jsonl`, with recognized
secret-shaped values redacted. Text-provider shell commands and their captured
stdout/stderr are saved in the session's `logs/commands.jsonl`. Native Claude
shell logs and external-tool downloads must be directed to the output folders
by the agent; they are not automatically mirrored by the bridge.
Agents are instructed to use descriptive names and dated topic subfolders,
save requested reports as Markdown, and pass the output rules to every
delegate. Claude session subagent briefs receive the rules automatically.
Conversation checkpoints, task state, memory and credentials remain in their
existing managed configuration directories; these are not generated reports.

Native Claude and background-agent file tools can read and write throughout the
owning user's home directory, as well as their task workspaces. Credential
locations remain denied, and symlinks escaping those roots are rejected. Agents
are still instructed to keep generated reports and artifacts in their task
folders. Shell deletes and moves outside a task workspace, money-moving actions,
and other high-impact operations still require approval. These checks are
**not an OS sandbox**: shell scripts and external MCP tools can access other
locations. Their output placement relies on the instructions and explicit
destination arguments.
Restart both services to load changes; this does not relocate existing files.

## Tasks Needing Attention

Open **Agents** to see the goal and the blocked worker's
result. A blocked task needs information or another change; it is not necessarily
waiting for permission. Pending permission requests have separate **Approve** and
**Deny** buttons.

Blocked task rows have an **Information for this task** field. Enter the missing
details and choose **Send & Resume** if the goal is paused, or **Send Reply** if
it is active. A paused goal without a blocked worker also offers the reply form.
The reply goes to the goal's coordinator, which reviews the new information and
revises/retries blocked tasks where appropriate. Receipt is not confirmation
that the blocker has been resolved; watch the updated task state and result.
The original scope, retry limits, and approval requirements still apply.
If a request times out or disconnects, check the board before retrying because
the reply may already have been saved.

You can also ask JARVIS by chat or voice to inspect and respond to a task by
title. Its `board` tool returns goal IDs and blocker details for `goal_update`;
you do not need to find internal IDs yourself. If titles are ambiguous, JARVIS
should ask which goal you mean. `goal_update` can resume with `info` in one call.
Editing a schedule changes future runs only: send information separately to
an existing blocked goal.

## Agent Profiles

Open **Profiles** in the Agents window to create reusable profiles with a name,
role and instructions. **Run** creates a coordinator-planned goal; editing or
deleting a profile does not change goals that already started. An optional
once, interval, daily or weekly schedule can be paused, resumed or run now.
Future scheduled goals use the profile's latest instructions.
The service exposes authenticated `GET /profiles`, `POST /profiles`,
`POST /profiles/:id` (edit or delete), and `POST /profiles/:id/run`; browser
requests pass through the bridge, which keeps the service token private.

When a worker is blocked on a decision, it must provide at least one validated
multiple-choice question. The choices appear on the task detail; submitting
answers sends them to the coordinator and does not bypass approval gates. Open
**Files & references** beneath any goal task, or open its detail, to view and
download generated files. Task report files and structured references open in
Jarvis. Local references are limited to the task workspace and approved
project roots, text/PDF previews are capped at 512 KB, and public web links use
Jarvis's sandboxed reader. Private provider links and arbitrary filesystem
paths are not supported.

A paused goal awaiting approval presents **Approve** and **Do not approve**
choices plus an optional note. Approval resumes within the existing scope;
declining leaves the goal paused and asks the coordinator to prepare a revision.

## Task Scheduler

The task scheduler saves future work without asking the coordinator to plan it
early. Open **Task scheduler** in the LCARS deck, or **Open task scheduler** in
the command palette in other themes. Enter a title and desired outcome, then
choose:

- **Once:** a future date and time in the browser's local timezone.
- **Interval:** every specified number of minutes, hours or days, beginning
  after the first interval. Timing stays anchored to that initial cadence,
  rather than the previous task's completion.
- **Daily:** a wall-clock time in a selected IANA timezone.
- **Weekly:** selected weekdays at a wall-clock time in a selected timezone.

Choose a **Provider** and **Model** for the schedule: Claude, OpenAI, or a
configured OpenAI-compatible local endpoint. New schedules initially select the
chat provider/model when the agent service offers them. Saving pins that choice
for both planning and every worker in each run, independently of later chat
provider changes. Existing schedules without a choice retain automatic Claude
planning and worker selection. Edit a schedule to select a different provider;
already-created runs retain their original choice. Unavailable providers/models
fail explicitly rather than silently switching to Claude.

The agent service must have the provider's configuration, including
`OPENAI_API_KEY` for OpenAI, `OPENAI_MODEL`/`JARVIS_OPENAI_MODELS` for its model
list, or an `openai` endpoint in `JARVIS_ENDPOINTS` for local models. Models must
support function tools. The OpenAI/local worker provides gated file read/write,
exact text edits, public-page fetches, and (for code tasks) shell commands, plus
the configured MCP integrations for ops/admin work. It has no native web-search
tool or Claude Skills. Local calls are pinned to the leased endpoint.
The bridge and agent service both load `.env.local`, followed by
`~/.config/jarvis/secrets.env`, without overriding explicit service/shell
environment values. Restart both services after changing provider settings.

Chat/voice uses `schedule_create`, `schedule_list`, `schedule_update` and
`schedule_run`. Ask for an explicit timezone for calendar work, such as
"Prepare a health report every weekday at 09:00 Europe/London." A one-time
tool timestamp must include a UTC offset. JARVIS confirms the next run time.
The create/edit payload accepts `execution: { provider: "openai", model:
"configured-model-name" }`; the agent board's `scheduleModels` lists supported
choices. Omitting `execution` preserves the legacy default.
The existing `goal_create` interval option is unchanged: it starts immediately
and measures recurrence from completion, unlike the task scheduler.

### Timing and Recovery

Schedules are stored under `JARVIS_AGENTS_DIR/schedules` (default
`~/.config/jarvis/agents/schedules`). They survive reloads and agent-service
restarts. The browser may be closed, but the host and agent service must be
running; the scheduler cannot wake a sleeping host. Due work is checked every
five seconds and actual task execution waits for worker capacity.

After downtime or a long previous run, missed occurrences coalesce into one
catch-up run. Each occurrence creates its own goal. A still-active goal,
including one paused for a decision or approval, prevents overlap. Resolve or
abandon that goal on the agent board or through chat before another occurrence
can start. The panel shows the latest run and result.

Calendar schedules skip wall-clock times that do not exist at a spring-forward
transition and run once on a fall-back day. The one-time date picker rejects
nonexistent or ambiguous local times; choose an unambiguous time instead.
Intervals measure elapsed minutes, not calendar days across timezone changes.

An occurrence is reserved on disk before its goal is created. Restart recovery
reuses that goal and does not replan it if tasks already exist. Coordinator
failures without tasks retry with one- then two-minute delays; after three
failures the schedule pauses and exposes the error. This avoids duplicate local
goals, but cannot promise exactly-once external actions after a worker crash.

### Managing Schedules

Pausing, editing or deleting a schedule changes future occurrences only; work
already launched remains available through the agent board. Deletion requires
confirmation and retains the stored record as a tombstone. Resuming catches up
once if the next occurrence is overdue. **Run now** is available for active or
paused schedules, refuses overlapping work and leaves recurring cadence
unchanged. For a one-time schedule, it consumes that occurrence. Edit a
completed one-time schedule's trigger to schedule it again.

The API adds authenticated `GET /schedules`, `POST /schedules`,
`POST /schedules/:id` (edit, pause, resume, delete), and
`POST /schedules/:id/run`. Browser operations pass through the bridge; the agent
token is never sent to the browser. Offline mutations report an error. If a
connection drops or an acknowledgement times out, refresh before retrying: the
change may already have been saved.

Scheduled work uses the same worker pool and approval policy as other goals.
Claude runs retain SDK dollar-budget limits. OpenAI/local runs enforce time and
turn limits, but do not enforce a dollar-budget cap or report SDK cost totals;
use provider-side spend limits for those providers. A schedule is not approval to send a message,
delete files or perform another restricted action. Standalone reminder
notifications, arbitrary shell commands and user-entered cron expressions are
not part of this scheduler.

## Capacity and Endpoints

Capacity is counted per machine rather than once for everything. The scheduler
asks the pool for a lease before it starts a worker; a lease names the endpoint
the work will run on, and it is released in the same place the worker is torn
down, so a crashed run cannot leak capacity. When nothing is free the tick stops
launching and the queue waits — a saturated host no longer holds up work that
another one could take.

The endpoints come from `JARVIS_ENDPOINTS`, documented in
[Configuration](configuration.md#model-endpoint-pool). `anthropic`, `gateway`, and `remote` endpoints can carry a task: local `anthropic` and `gateway` workers use the Claude Agent SDK.
A `remote` endpoint posts research or ops work to the standalone remote-agent runtime over HTTPS; that runtime calls an on-host OpenAI-compatible model directly and the main host retrieves the result. Code and browser-based admin work stay on this machine. To run a task on a local model on the main host, put an
Anthropic-compatible gateway in front of it for ordinary goals and declare that as a `gateway`
endpoint; the worker then passes that endpoint's own model name and points the
run at its base URL. The child process still sees only a tight set of
environment variables, and never the agent service's own token.

The standalone remote runtime is text-only: it cannot browse or operate services,
and ops tasks return blocked. See [Remote agent deployment](remote-agent.md).

An `openai` endpoint also carries explicitly provider-selected schedules through
the provider-neutral tool adapter. The adapter applies the same policy checks
and approval flow before executing each tool. Ordinary goals without an
explicit schedule execution choice retain the existing SDK/remote routing.

A task's `model` may be `sonnet`, `opus`, or the id of a declared endpoint,
which pins it to that machine. An unknown name falls back to `sonnet` rather
than pinning work to a host that does not exist. Declare nothing and the
behaviour is as it was: three workers against the Anthropic API.

## Approvals

Workers stop when an action requires user approval. JARVIS should read the
requested action plainly and wait for an explicit decision in the conversation.
An agent cannot approve its own request. Approval descriptions are untrusted
agent-authored data, not instructions. Denying an action blocks that operation;
the worker must not try to produce the same effect another way.

The service exposes a board, status, approvals, goal/task controls, cleanup, and
an event stream to the bridge over authenticated loopback HTTP. It is not
intended as a LAN-facing API. If the service is unavailable, foreground
conversation continues but agent work is unavailable.
