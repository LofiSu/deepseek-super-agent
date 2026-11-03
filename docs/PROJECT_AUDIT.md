# Project audit — 2026-11-03

> Audit base: `main` at `cb32a17` (`chore: add super agent orchestration
> configuration (#78)`). Commands were run in a detached worktree at
> `origin/main`; the primary clone contained unrelated uncommitted WIP and was
> not used. This audit supersedes the stale `fa974ca` evidence in PR #74.

## 1. Repository state

| Item | Observation |
|------|-------------|
| Branch | `main`, clean in the detached audit worktree |
| HEAD | `cb32a17` |
| Remote | `git@github.com:LofiSu/deepseek-super-agent.git` |
| Last merged PR | **#78** orchestration configuration (10 files, +548) |
| Open PRs at checkpoint | **#74** (`docs/final-audit`, `BEHIND`, stale base), **#75** (this project-state docs PR), **#76** (`agent/gateway-hardening`, CI green), **#77** (`agent/imessage-admission`, CI green) |
| Issues | GitHub Issues disabled |
| Branch protection | required check `typecheck and test`; strict; admins enforced; conversation resolution required |
| Node / pnpm | Node v22.23.4 / pnpm 9.15.9 |
| Package scripts | `lint`, `format:check`, `typecheck`, `test`, `test:coverage`, `demo`, `demo:local`, `demo:feishu`, `bench:bakeoff` |

`#78` added the project orchestration contract in `CLAUDE.md`, agent
definitions, a stop guard, and the `autonomous-engineering` skill. It makes the
main session the only orchestrator, caps the validating pipeline at three
implementation agents, caps a session at four completed cycles, and requires
the main session alone to write `.super-agent/state.json`.

## 2. Verified quality gates

```text
pnpm typecheck                                         exit 0
pnpm lint                                              lint ok (217 tracked files)
pnpm format:check                                      exit 0
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run   372 passed, 15 skipped (387)
                                                      55 files: 52 with passing tests,
                                                      3 fully skipped
pnpm test:coverage                                     371 passed, 51 files
                                                       statements 80.68% (7171/8888)
                                                       branches   79.67% (2465/3094)
                                                       functions  89.72% (646/720)
                                                       lines      80.68% (7171/8888)
```

File-count detail for the plain offline run:

- 52 files execute at least one passing test. `test/live-demo.test.ts` is one of
  them: it passes one offline test and skips three live tests.
- 3 files are fully skipped: `test/demos-real-channels.test.ts` (3 tests),
  `test/live-e2e.test.ts` (7), and `test/team-live.test.ts` (2).
- The 15 skipped tests are the live model and real-channel suites. No live model
  or real-channel acceptance run was performed in this audit.

Coverage note: the earlier `bb11c96` run reported 79.69% branches
(2469/3098). The current `cb32a17` run reports 79.67% (2465/3094). `#78` changed
no `src/` file, so this is run-to-run V8 coverage variance, not a regression.
The current numbers above are the audited figures.

## 3. Architecture state

The module boundaries from `PLAN.md` §2 and `docs/DOMAIN_ALIGNMENT.md` are
present in `src/`:

- `src/shared` — types and ports; no business logic.
- `src/harness` — Router/Worker sessions, tools, jobs, team, mesh, daemon.
- `src/core` — Engine, intake, evals, tickets, assignments, replies, lifecycle.
- `src/store` — SQLite source of truth, outbox, jobs, sessions.
- `src/ingress` — admission, shards, batching, thread state.
- `src/channels` — CLI, Feishu, GitHub, A2A, iMessage, outbox adapters.
- `src/env` — isolated workspaces, sanitization, vault, seccomp.
- `src/watchdog` — stuck/drift detection and fail paths.
- `src/memory` — spill-backed long-term memory and recall.
- `src/speculate` — speculative delivery gate.
- `src/metrics` — counters, curves, bake-off.
- `src/gateway` — local OpenAI/Anthropic/Gemini-compatible proxy.
- `src/runtime.ts` — composition root.

The Engine owns ticket/assignment transitions. One direct-write deviation exists:
`Harness.launch` assigns the chosen node and then calls
`this.opts.store.putDoc('ticket', started.id, started)` at
`src/harness/loop.ts:134-135`. That is a scheduler write to the ticket
aggregate, even though it does not change ticket status or make a domain
decision. P1-3 must route node placement through an Engine-owned callback; until
that merge, the accurate claim is "Engine owns domain transitions", not "Engine
is the only writer". No new direct writes are permitted.

The gateway is an infrastructure surface, not a domain actor.

## 4. Findings

### IMESSAGE-ADMISSION — iMessage admission is default-open

`imessageTrigger()` sets `addressed: 'direct'` for every message
(`src/channels/imessage.ts:110-132`). Admission ordering is not the defect:
`src/ingress/filter.ts:36-58` runs `admissionDeny` before checking `addressed`.
The defect is that the default run supplies no admission rules, so `deny`
returns nothing, and the always-`direct` marker then passes the fast path with
`mention-or-direct`. `--handle` / `DS_AGENT_IMESSAGE_HANDLE` is optional and no
group metadata is read, so a default run ingests any sender in any chat,
including group chats. Any party who can message the agent's Apple ID can
trigger work. PR #77 implements the fail-closed gate, but its first independent
review found that a message joined to multiple chats is deduped to one row, so
a group message can still be classified as 1:1. The fix aggregates groupness
across all `chat_message_join` rows and treats missing metadata as
unknown/group; it is in progress on `agent/imessage-admission`.

### P1-3 — Worker-mesh capacity is advisory

`Harness.launch` logs `[mesh] ... capacity-full` and runs the Worker anyway.
`WorkerMeshRegistry` correctly reports no free node, but no scheduler consumes
that signal. With `DS_AGENT_MESH_CAPACITY=1`, two Workers can run concurrently.
This is being fixed in `agent/P1-3-mesh-backpressure`.

### P1-6 — No restart replay

`Runtime.start` starts the daemon and pending assessments but does not scan for
interrupted assignments. A killed process leaves an assignment `running` until
the watchdog (or forever if the watchdog is not run). `serve` explicitly
documents that in-flight turns are not reconstructed. This is scheduled after
the mesh change because both touch `Harness.launch`/`drain` and runtime release.

### GATEWAY-HARDENING — Gateway auth/exposure edges

- Bearer token comparison is `===`, not constant-time.
- An empty token is accepted at server start (all requests with `Bearer ` may
  then pass depending on header parsing).
- `/`, `/ui`, `/health` are unauthenticated; `/health` exposes provider IDs,
  plugin names, and metrics.
- A non-loopback `--host` bind is accepted without an exposure warning.
- A pre-existing token file is reused without re-applying `0600`.
- Token-file reads follow symlinks. A writable state directory could redirect
  the token path; this is a follow-up to the current hardening PR.
- The dashboard is read-only and does not embed the token; that part is sound.

### GATEWAY-REVIEW — #64 has no independent review record

`#64` added 4,390 lines and 12 test files after the last roadmap audit.
Coverage on the merged tree is 80.68% lines / 79.67% branches, below the 82.40%
baseline recorded for `fa974ca`. The absolute drop is explained by the new
surface, but there was no independent review artifact for the gateway/iMessage
code. PR #76 has now received an independent review (APPROVE, with non-blocking
follow-ups); the #77 review is in progress. Reviews are recorded in
`docs/PR_REVIEW_LOG.md`.

### SERVE-CHANNEL-LOOP — `serve` has no inbound channel loop

`ds-agent serve` drains persisted work and runs assessments, but does not poll
Feishu/GitHub/iMessage. Triggers written by another process are not picked up.
This is documented; it remains a production limitation rather than a bug.

## 5. Live/operator-only evidence (not reproduced)

- `docs/MODULES.md` records a live Magpie run of 207 passed / 3 skipped. That
  line remains operator-only and is not reproduced here (roadmap P1-9).
- `pnpm demo` (real GitHub issues/comments) requires operator `gh` auth and a
  live model. It was not run.
- `pnpm demo:feishu` requires real Feishu credentials. It was not run.

## 6. Audit conclusion

The offline gate is green on `cb32a17` and the architecture still matches its
contracts, with the documented `Assignment.node` deviation. The highest-value
work is not new features: it is closing the default-open iMessage admission
path, making mesh capacity real, adding restart recovery, and completing the
review/hardening of the newly merged gateway surface.
