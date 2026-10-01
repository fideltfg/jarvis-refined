# Marketing plan — JARVIS Refined as a clustered, any-model AI assistant

Date: 2026-09-30
Status: draft, awaiting owner review
Owner: fideltfg (repo `fideltfg/jarvis-refined`)

## How an agent uses this plan

This plan is written to be executed by AI agents, one task at a time, with a
human owner holding the gates.

- Work tasks in ID order unless `Depends` says otherwise. A task is ready when
  every task it depends on is `done`.
- Every task names its **Output** (a file path) and a **Done when** check. A
  task is not done until the check passes. Write outputs under
  `docs/marketing/out/` unless the task says otherwise.
- Record progress in `docs/marketing/out/STATUS.md`: one line per task,
  `ID · status (todo | doing | blocked | done) · date · note`.
- `GATE` tasks need the owner's explicit yes. Stop, write what you need into
  STATUS.md as `blocked`, and do not work around the gate.
- **Claim rule.** Any public-facing sentence about what JARVIS does must be
  backed by a row marked `Shipping` in the product truth register below, or by
  a benchmark result produced in this plan. If a claim depends on a `Planned`
  row, the copy must say "planned" or the claim must be cut.
- Never post, publish, email, message, or spend money. Agents draft; the owner
  publishes (see Gates).

## Product truth register

Verified against the working tree on 2026-09-30. Re-verify before Phase 2; code
moves faster than marketing.

| Capability | State | Evidence |
|---|---|---|
| Voice assistant with 3D HUD, themes, wake word, barge-in | Shipping | `README.md`, `docs/architecture.md` |
| Claude, OpenAI, or one OpenAI-compatible local model for conversation | Shipping | `docs/providers-and-voice.md` |
| Provider failover before any text or tool call is emitted | Shipping | `docs/providers-and-voice.md` |
| Background agents: goals → tasks, up to 3 parallel workers, approvals, persistence | Shipping | `docs/background-agents.md`, `agents/` |
| Local text-to-speech (Kokoro, WebGPU in browser) | Shipping | `docs/providers-and-voice.md` |
| Many model endpoints declared in `JARVIS_ENDPOINTS` (local, LAN, cloud) | Uncommitted | `bridge/endpoints.mjs` (untracked) |
| Per-endpoint concurrency, health probes, weights, task-kind routing | Uncommitted | `bridge/endpoints.mjs`, `agents/pool.mjs` (untracked) |
| Agent tasks leased across several machines ("4 boxes × 2 jobs = 8 tasks") | Uncommitted | `agents/pool.mjs`, `agents/scheduler.mjs` (modified) |
| Agent workers on a non-Claude model | Partial | Only through a `gateway` endpoint (Anthropic-compatible proxy). Plain Ollama/vLLM endpoints serve chat, not agent tasks (`agents/pool.mjs` header). |
| Goal planning (coordinator) on a non-Claude model | Not built | `agents/coordinator.mjs` accepts only `sonnet`/`opus` |
| Fully offline agent run | Not built | Blocked by the coordinator row above |
| Fully offline voice | Not built | Browser `SpeechRecognition` in Chrome/Edge sends audio to a cloud service; Porcupine wake word needs an AccessKey (verify its offline behaviour) |
| Splitting one large model across several weak machines | Not a JARVIS feature | Possible with llama.cpp RPC or exo behind one endpoint; JARVIS would see a single endpoint |

**What this means for the pitch.** The honest story today is "one assistant,
many model endpoints, agent work spread across them". The headline "turn old
hardware into an offline agent cluster" becomes true only after Phase 0 lands.
Until then it must be labelled as the direction of the project.

## Positioning

**One-liner (after Phase 0):** JARVIS Refined is a voice-driven AI assistant
that spreads agent work across every machine you own — cloud models, a gaming
PC, and the old laptops in the cupboard — and keeps working when the internet
doesn't.

**One-liner (before Phase 0):** A voice-driven AI assistant that runs on any
model — Claude, OpenAI, or your own local LLMs — and is growing into a
multi-machine agent cluster.

**Audiences, in priority order**

1. *Homelab and self-hosting users* who already run Ollama or llama.cpp and own
   idle hardware. Care about: reusing hardware, privacy, no subscription.
2. *Local-LLM enthusiasts* (r/LocalLLaMA crowd). Care about: which models
   work, tokens/sec, tool-calling quality, real benchmarks.
3. *Developers who want an agent runner* with approvals and budgets. Care
   about: safety gates, persistence, parallelism, cost control.
4. *Privacy-sensitive small teams and makers.* Care about: data never leaving
   the building.

**Message pillars** (each needs a proof point before it goes public)

| Pillar | Claim | Proof required |
|---|---|---|
| Any model | Mix Claude, OpenAI, and local models in one assistant | Shipping; screenshot of provider menu with 3 providers |
| Your hardware is the cluster | Each machine is an endpoint; work is leased to whichever has room | E1 merged + B1 benchmark |
| Old hardware earns its keep | A 2016 desktop can carry research tasks | B1 numbers per machine |
| Works offline | Agents plan and run with no internet | E3 + E4 merged + B2 offline test log |
| Safe by default | Hard stops, approvals, budgets, read-only start mode | Shipping; `docs/tools-and-safety.md` |

**Avoid:** "free Claude", "replaces cloud AI", speed claims without numbers,
implying one weak box runs a 70B model, and any Marvel/Iron Man imagery or
wording in marketing (see G1).

## Phase 0 — Make the claims true (engineering)

These are code tasks for a coding agent in this repo. Each ends with
`npm test` and `npm run lint` passing.

### E1 · Land multi-endpoint pooling
- **Depends:** —
- **Steps:** Review the uncommitted `bridge/endpoints.mjs`, `agents/pool.mjs`
  and changes to `agents/scheduler.mjs`, `agents/worker.mjs`,
  `bridge/providers.mjs`. Add tests for `endpoints.mjs` and `pool.mjs` if
  missing. Document `JARVIS_ENDPOINTS` in `docs/configuration.md` and add a
  "Running across several machines" section to `docs/background-agents.md`.
- **Output:** a branch and PR (owner merges).
- **Done when:** tests cover parsing, bad-entry handling, health TTL, lease
  limits per endpoint and the global ceiling; docs show a 3-endpoint example.

### E2 · Gateway recipe for local models as agent workers
- **Depends:** E1
- **Steps:** Pick one Anthropic-compatible proxy in front of Ollama or
  llama.cpp (candidates: LiteLLM proxy; Ollama's own Anthropic-compatible API
  if the installed version has it — verify, don't assume). Write a tested
  recipe: install, config, a `gateway` entry in `JARVIS_ENDPOINTS`, one agent
  task completed end to end.
- **Output:** `docs/local-cluster.md`
- **Done when:** a clean machine following the doc completes a `research` task
  on a local model, and the doc lists which models were tried and which failed
  at tool calling.

### E3 · Coordinator on any endpoint
- **Depends:** E1, E2
- **Steps:** Let `agents/coordinator.mjs` take an endpoint id (env
  `JARVIS_COORDINATOR_ENDPOINT`), reusing `agentEnv()` from `agents/worker.mjs`
  for gateway routing. Keep Opus as default.
- **Done when:** a goal is planned and completed with no Anthropic endpoint
  configured; test added.

### E4 · Offline voice path
- **Depends:** —
- **Steps:** Add a local speech-to-text option (e.g. whisper.cpp server or
  faster-whisper behind the bridge) and a documented wake-word path that works
  with no network. Confirm Kokoro works from cache with no network.
- **Done when:** B2 below passes with the network cable unplugged.

### E5 · LAN security note
- **Depends:** E1
- **Steps:** Ollama and most local servers have no auth by default. Add
  guidance to `docs/tools-and-safety.md`: bind to LAN only, firewall, or put a
  keyed proxy in front; use `apiKeyEnv`. The agent API stays loopback-only.
- **Done when:** the cluster doc links to it and it names the exposed ports.

### B1 · Old-hardware benchmark
- **Depends:** E2
- **Steps:** Build a reference cluster from real machines the owner has (GATE
  G3 asks for the list). For each: CPU, RAM, GPU/VRAM, year, model, quant,
  tokens/sec, time to finish a fixed set of 10 research tasks, tool-call
  success rate, power draw if measurable. Run the same set on one machine and
  on the pool.
- **Output:** `docs/marketing/out/benchmark.md` + raw CSV
  `docs/marketing/out/benchmark.csv`
- **Done when:** results table exists, pool vs single-box speedup is stated,
  and failures are reported, not hidden.

### B2 · Offline acceptance test
- **Depends:** E3, E4
- **Steps:** Disconnect WAN. Speak a goal. Record that it is planned, run on
  local endpoints, and reported by voice.
- **Output:** `docs/marketing/out/offline-test.md` + screen recording path.
- **Done when:** the log shows zero outbound WAN requests (e.g. via firewall
  log) for the whole run.

## Phase 1 — Assets (drafted by agents, approved by owner)

### A1 · Messaging doc
- **Depends:** —
- **Output:** `docs/marketing/out/messaging.md` — both one-liners, a
  50/150/300-word description, pillar copy, FAQ (10 questions a homelab user
  would ask, answered from the truth register).
- **Done when:** every claim cites a register row or benchmark.

### A2 · README rework
- **Depends:** A1, E1
- **Steps:** Lead with the any-model + cluster story; add an architecture
  diagram (browser → bridge → endpoint pool → machines); keep the existing
  guides list. Credit upstream `adewaskar/jarvis` per the MIT licence.
- **Output:** PR against `README.md`.
- **Done when:** a new reader can tell within the first screen what runs where
  and what works offline today.

### A3 · Cluster quickstart
- **Depends:** E2
- **Output:** the "10-minute cluster" section of `docs/local-cluster.md`:
  two machines, one `JARVIS_ENDPOINTS` file, first agent task.
- **Done when:** a second agent, given only this section and two VMs, gets a
  task to run on the second VM.

### A4 · Demo video script and shot list
- **Depends:** B1 (for numbers), B2 (for the offline shot, else cut it)
- **Output:** `docs/marketing/out/demo-script.md` — 90-second and 5-minute
  versions. Must include: machines on a desk, agent board showing tasks spread
  across named endpoints, a spoken goal, the network unplugged (only if B2 is
  done).
- **Done when:** every on-screen claim maps to a register row.

### A5 · Landing page
- **Depends:** A1, A2, G1
- **Output:** static page (GitHub Pages, `docs/site/`) with hero, diagram,
  benchmark table, quickstart link, safety section.
- **Done when:** it works at phone width and has no claim beyond A1.

### A6 · Hardware compatibility page
- **Depends:** B1
- **Output:** `docs/hardware.md` — table of tested machines and models, plus
  an issue template `.github/ISSUE_TEMPLATE/hardware-report.md` so users can
  add their own.
- **Done when:** the template captures the same fields as B1.

### A7 · Channel drafts
- **Depends:** A1–A4
- **Output:** `docs/marketing/out/posts/` — one file per channel:
  `show-hn.md`, `r-localllama.md`, `r-selfhosted.md`, `r-homelab.md`,
  `x-thread.md`, `mastodon.md`, `ollama-discord.md`, `litellm-discord.md`.
- **Rules:** follow each community's self-promotion rules (the agent reads
  and quotes them at the top of each draft); lead with the benchmark and the
  hardware, not the product; disclose authorship.
- **Done when:** each draft has title, body, first comment, and a note on the
  best posting time for that channel.

### A8 · Creator outreach list
- **Depends:** A4, G4
- **Output:** `docs/marketing/out/outreach.csv` — homelab / local-AI
  YouTubers and bloggers: name, channel, public contact route, why they fit,
  a two-sentence personal note. Public business contacts only.
- **Done when:** ≥15 rows; nothing is sent (G5).

## Phase 2 — Launch (owner publishes)

Order is chosen so each post can link to the previous one's discussion and
fixes land between waves.

| Step | Day | Channel | Asset | Gate |
|---|---|---|---|---|
| L1 | 0 | GitHub release (tag, notes) | A2, A3, A6 | G2 |
| L2 | 0 | r/LocalLLaMA, r/selfhosted | A7 | G2 |
| L3 | 2 | Show HN | A7 | G2 |
| L4 | 3 | r/homelab + Ollama / LiteLLM Discords | A7 | G2 |
| L5 | 3–14 | Creator outreach | A8 | G5 |
| L6 | 7 | Demo video on YouTube | A4 | G2 |

**Agent role during launch (L-tasks):** watch the threads the owner links in
STATUS.md; within each day produce `docs/marketing/out/launch-log.md` with
questions asked, bugs reported (open GitHub issues as drafts for the owner),
suggested replies. Agents do not reply publicly.

## Phase 3 — Keep it going (weeks 3–12)

- **C1 · Weekly digest** — every Monday, write
  `docs/marketing/out/weekly/<date>.md`: stars, clones, issues opened/closed,
  new hardware reports, top question of the week, one proposed doc fix.
- **C2 · Hardware wall** — fold new hardware-report issues into
  `docs/hardware.md` via PR.
- **C3 · Follow-up content** — one post every two weeks drawn from real data:
  "What a 2014 ThinkPad can do as an agent node", "Which small models survive
  tool calling", "Offline JARVIS in a power cut".
- **C4 · Re-verify the register** — before each post, re-run the checks in the
  truth register and update this file.

## Metrics

Targets are placeholders for the owner to set at G2.

| Metric | Source | 30-day target |
|---|---|---|
| GitHub stars | GitHub | _owner sets_ |
| Unique cloners | GitHub traffic | _owner sets_ |
| Hardware reports filed | issue label `hardware-report` | _owner sets_ |
| Users running ≥2 endpoints | opt-in survey in discussions | _owner sets_ |
| Issues closed within 7 days | GitHub | ≥ 70% |

## Gates (owner decisions)

| Gate | Decision | Blocks |
|---|---|---|
| G1 | **Name and imagery.** "JARVIS" and the Stark theme are Marvel IP; HAL, MOTHER, WOPR and LCARS themes also borrow film/TV IP. Decide: keep the name for the repo but market under a distinct name, or rename. Get advice if unsure. | A5, all public posts |
| G2 | Approve each public post, release and target numbers before publishing. | L1–L6 |
| G3 | List the physical machines available for the benchmark. | B1 |
| G4 | Approve the outreach criteria. | A8 |
| G5 | Send each outreach message personally. | L5 |
| G6 | Any spend (ads, hosting, hardware). None is planned. | — |

## Risks

| Risk | Mitigation |
|---|---|
| Launching the offline claim before E3/E4 land draws "this still needs Claude" replies | Use the pre-Phase-0 one-liner until B2 passes |
| Small local models fail at tool calling, so agent tasks on old hardware look bad | E2 lists working models; route only `research`/summary kinds to weak nodes via endpoint `kinds` |
| Exposed unauthenticated Ollama ports on users' LANs | E5 guidance, repeated in the quickstart |
| Trademark complaint | G1 before any public asset |
| Upstream attribution dispute | Credit `adewaskar/jarvis` in README and release notes |
