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

The provided `deploy/jarvis-agents.service` unit loads the same secrets file
when running the agent service under systemd. The bridge still needs
`JARVIS_AGENTS=1` and the token in its own environment. Configure the service
port and state paths with the variables in the
[Configuration reference](configuration.md).

## Workflow

Ask JARVIS to handle work that takes more than one turn, such as a code change,
research report, service operation, or administrative task. The coordinator
plans tasks, schedules workers against the available capacity, tracks progress,
and reviews task results. Goals can be paused, resumed, updated with new
information, or abandoned. Recurring goals can be scheduled with an interval.

Worker categories are `code`, `research`, `ops`, and `admin`. Workers have
per-task turn, time, and spending limits. Work is persisted under
`~/.config/jarvis/agents`; task workspaces use `~/.jarvis-work` by default.
Completed task workspaces can be removed with JARVIS's `cleanup` agent tool.

## Capacity and Endpoints

Capacity is counted per machine rather than once for everything. The scheduler
asks the pool for a lease before it starts a worker; a lease names the endpoint
the work will run on, and it is released in the same place the worker is torn
down, so a crashed run cannot leak capacity. When nothing is free the tick stops
launching and the queue waits — a saturated host no longer holds up work that
another one could take.

The endpoints come from `JARVIS_ENDPOINTS`, documented in
[Configuration](configuration.md#model-endpoints). Only `anthropic` and
`gateway` endpoints can carry a task: the worker drives the Claude Agent SDK,
which speaks the Anthropic API alone. To run a task on a local model, put an
Anthropic-compatible gateway in front of it and declare that as a `gateway`
endpoint; the worker then passes that endpoint's own model name and points the
run at its base URL. The child process still sees only a tight set of
environment variables, and never the agent service's own token.

An `openai` endpoint — Ollama and the like — serves conversation and cheap
summarising through the bridge instead. It is not given agent work, because the
safety gate lives in the SDK's hooks and would not exist there.

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
