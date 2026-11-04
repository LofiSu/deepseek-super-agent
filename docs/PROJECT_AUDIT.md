# Project audit — 2026-11-04 (final integration)

> Audit base: `main` after PR #140 (`661e56d`). This section supersedes the
> 2026-11-03 audit below for current status; the older sections remain as
> history. Checks were run in dedicated worktrees; the primary clone's unrelated
> WIP was not used.

## 0. Final integration audit (2026-11-04)

### Repository and integration state

| Item | Observation |
|------|-------------|
| `main` | `661e56d` merge of #140 |
| Merged surfaces | A2A HMAC HTTP (`7a1d732`), lifecycle/schema v3 (`888f810`), slow path (`788be60`), remote mesh (`d9ded0b`), backup/release (`d67731a`), combined channels (`0cdea17`), local UI (`123ee40`), CLI wiring (`1e01862`), channel slow path (`268809d`), usage accuracy (`58c410a`), release workflow (`a1985c0`), iMessage nanosecond dates (`111481d`), iMessage non-ASCII argv (`af6b011`), iMessage canned-ack suppression (`661e56d`) |
| Required check | `typecheck and test`; strict, admins enforced, conversation resolution required |
| CI evidence | #129 `41829844125` pass; #131 `41826730675` pass; #135 `41845266705` pass; #136 `41844155920` pass; #132 head `21cc421`, #134 head `56cb001`, #139 head `50cf9d1`, #140 head `69a243c` green; post-merge main runs `41848077717` (`661e56d`) and `41847695711` (`af6b011`) pass |
| Offline suite | #135 merged head: 75 files, 724 tests, 709 passed, 15 skipped, 0 failed (CI-equivalent env) |
| Live evidence | none added by this program; bake-off remains unmeasured |

### Findings

1. **The implementation now matches the architecture contract for the shipped
   surfaces.** `PLAN.md` T09/T17/T47/T48/T49/T50 were corrected from stale
   “not wired”/`[~]` descriptions. T47 and T48 remain honestly partial: remote
   mesh has no default listener, and memory recall has no embedding path.
2. **The security model is implemented, not planned.** `docs/SECURITY.md` now
   documents the merged A2A, remote mesh, and local UI controls, including the
   required UI token, speculative-ticket filtering, event-field whitelist,
   per-request metrics read, and bounded SSE backpressure.
3. **No new Critical/High defect is exposed by default.** A2A and mesh still
   open no listener; the UI binds loopback. The High A2A replay risk remains a
   deployment requirement (unique per-node secret or shared durable replay
   cache), unchanged by this program.
4. **The owner gate on #132 was bypassed, not honored.** This session held
   #132 as owner-gated; another session merged it at `a1985c0` on 2026-11-04
   without recorded owner approval. A post-merge audit found the workflow is
   `workflow_dispatch` only, with `permissions: contents: read`, no
   `secrets.*`, no publish step, and an artifact upload. That limits the blast
   radius but does not constitute approval. #134, #139, and #140 were also
   merged by other sessions without independent review in this log; all three
   heads had green `typecheck and test`. No production infrastructure, secret storage, auth
   redesign, destructive migration, or live external send was performed.
5. **Verification limits are explicit.** CI and offline fixtures pass; no live
   model bake-off or real Feishu acceptance was run. iMessage daemon tests use
   fakes and no live send was made.

### Corrected contradictions and residual risk

- `PLAN.md` slow-path wording, `docs/ROADMAP.md` T49 row, `docs/UI.md` CLI
  wiring note, and `docs/DEVELOPMENT_STATUS.md` baseline were stale after the
  merges and are corrected here.
- The UI's shared-token, single-user, plain-loopback model and the A2A
  process-local replay cache are documented residual risks, not hidden
  assumptions.
- T48's lexical recall evaluation is synthetic and small; month-scale and
  embedding recall are not claimed.

## 1. Repository state (2026-11-03 audit, historical)

| Item | Observation |
|------|-------------|
| Branch | `main`, clean in the detached audit worktree |
| HEAD | `34aef25` |
| Remote | `git@github.com:LofiSu/deepseek-super-agent.git` |
| Last merged PR | **#84** mesh release-order correction (merged 2026-11-03T06:45:36Z) |
| Merged this cycle | #75 docs (`08ea78f`), #76 gateway (`aae182c`), #77 iMessage (`03a4c02`), #78 orchestration (`cb32a17`), #79 mesh (`1dc9500`), #80 docs (`2c02f4b`), #81 group fix (`f4ba77a`), #82 token hardening (`1c165ef`), #84 mesh correction (`34aef25`) |
| Open PRs at checkpoint | #74 (refreshed audit, head `3119369`), #83 (this reconciliation), #85 (P1-6 restart recovery) |
| Issues | GitHub Issues disabled |
| Branch protection | required check `typecheck and test`; strict; admins enforced; conversation resolution required |
| Node / pnpm | Node v22.23.4 / pnpm 9.15.9 |
| Package scripts | `lint`, `format:check`, `typecheck`, `test`, `test:coverage`, `demo`, `demo:local`, `demo:feishu`, `bench:bakeoff` |

`#78` added the project orchestration contract in `CLAUDE.md`, agent
definitions, a stop guard, and the `autonomous-engineering` skill. It makes the
main session the only orchestrator, caps the validating pipeline at three
implementation agents, caps a session at four completed cycles, and requires
the main session alone to write `.super-agent/state.json`. The Stop guard was
verified against block, idle, owner-stop, only-blocked, stale-progress, paused,
active/terminal background, and missing-state cases.

`#75` merged the first project-state checkpoint, but its final reconciliation
commit (`bdce7ea`) landed after the merge and is not on `main`. `#80` then
reconciled part of the state. This PR carries the corrected state forward; it
does not rewrite merged commits.

## 2. Verified quality gates

```text
pnpm typecheck                                         exit 0
pnpm lint                                              lint ok (224 tracked files)
pnpm format:check                                      exit 0
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run   414 passed, 15 skipped (429)
                                                      55 files: 52 with passing tests,
                                                      3 fully skipped
pnpm test:coverage                                     413 passed, 51 files
                                                       statements 81.81% (7667/9371)
                                                       branches   80.06% (2703/3376)
                                                       functions  89.77% (685/763)
                                                       lines      81.81% (7667/9371)
```

File-count detail for the plain offline run:

- 52 files execute at least one passing test. `test/live-demo.test.ts` is one of
  them: it passes one offline test and skips three live tests.
- 3 files are fully skipped: `test/demos-real-channels.test.ts` (3 tests),
  `test/live-e2e.test.ts` (7), and `test/team-live.test.ts` (2).
- The 15 skipped tests are the live model and real-channel suites. No live model
  or real-channel acceptance run was performed in this audit.

Coverage note: the earlier `bb11c96` run reported 79.69% branches
(2469/3098), `cb32a17` 79.67% (2465/3094), `03a4c02` 79.84% (2528/3166),
`1dc9500` 80.04% (2587/3232), `f4ba77a` 80.42% (2646/3290), and `1c165ef`
80.14% (2689/3355). The `34aef25` CI run (`41591922248`) reports 80.06%
(2703/3376); a local run on the same commit reported 80.05% (2702/3375), a
one-branch V8 variance. The figures above use the CI run.

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

The Engine owns ticket/assignment transitions. At `34aef25` the Harness has no
direct ticket write: `Harness.launch` reads the ticket, picks a node, and
persists placement through `this.opts.assignmentPlaced(...)` at
`src/harness/loop.ts:298`; `Engine.assignmentPlaced` is the sole writer of
`Assignment.node`. #79 removed the earlier `store.putDoc('ticket', ...)`
deviation, so "Engine owns domain transitions" now also holds as "Engine is the
only writer" for ticket state. Do not add scheduler writes to the ticket
aggregate.

The gateway is an infrastructure surface, not a domain actor.

## 4. Findings

### IMESSAGE-ADMISSION — iMessage admission was default-open (resolved)

Before #77, `imessageTrigger()` set `addressed: 'direct'` for every message, so
a default run with no admission rules ingested any sender in any chat. At
`34aef25` it sets `addressed: 'direct'` only for non-group messages
(`src/channels/imessage.ts:215-225`). Admission ordering was not the defect:
`src/ingress/filter.ts:36-58` runs `admissionDeny` before checking `addressed`.
The defect was that the default run supplied no admission rules, so `deny`
returned nothing, and the always-`direct` marker then passed the fast path with
`mention-or-direct`. `--handle` / `DS_AGENT_IMESSAGE_HANDLE` was optional and no
group metadata was read, so a default run ingested any sender in any chat,
including group chats. Any party who could message the agent's Apple ID could
trigger work. PR #77 merged the fail-closed gate, but its independent review
returned REQUEST_CHANGES before merge: a message joined to multiple chats was
deduped to one row, so a group message could still be classified as 1:1, and
missing chat metadata defaulted to 1:1. PR #81 merged the correction at
`f4ba77a`: groupness is aggregated across every joined chat, missing/ambiguous
metadata is unknown/group, the group GUID is retained in
`channel.address.group`, the handle is trimmed once for both gate and SQL, and
old schemas raise a clear cached error. Independent review: APPROVE. Residual
non-blocking items: tests for group-then-1:1 join order and page-boundary joins
are absent; an ambiguous row can fall back to another joined chat's GUID as the
group id; the CLI rethrow path is covered only by inspection.

### P1-3 — Worker-mesh capacity and release ordering

On the pre-#79 tree, `Harness.launch` logged `[mesh] ... capacity-full` and ran
the Worker anyway. #79 merged a bounded FIFO, Engine-owned placement, and
metrics at `1dc9500`, but its independent review returned REQUEST_CHANGES after
merge: `Assignments.report()` fired the `onAssignmentEnded`/`onTicketEnded`
hooks before the terminal `putDoc`, so the pump could re-read a pre-terminal
ticket and start a queued Worker after the ticket ended. Turns started by
`deliver()`, `resume()`, and job completion were not in `activeWorkers`, making
the capacity-1 interleaving deterministic. #84 merged at `34aef25`: both hooks
now run after persistence, `Runtime` defers release via `queueMicrotask`,
`queueState()` rejects missing/ended/paused/no-assignment/terminal entries, and
`startQueued()` re-reads immediately before start. Independent review: APPROVE.
Residual non-blocking items: two narrow `queueState` branch tests and the
pre-existing non-queued start-error cleanup.

### P1-6 — No restart replay

`Runtime.start` starts the daemon and pending assessments but does not scan for
interrupted assignments. A killed process leaves an assignment `running` until
the watchdog (or forever if the watchdog is not run). `serve` explicitly
documents that in-flight turns are not reconstructed. This is scheduled after
the mesh change because both touch `Harness.launch`/`drain` and runtime release.

### GATEWAY-HARDENING — Gateway auth/exposure edges

`#76` merged constant-time bearer comparison, empty-token refusal, a
non-loopback exposure warning, token-file `0600` repair with a fail-closed
error, `nosniff`/`no-store` headers, and no token in the dashboard. `#82` merged
at `1c165ef` the symlink/hard-link/non-regular rejection, `O_NOFOLLOW` reads,
exclusive creation, RFC 7235 `Bearer` parsing, explicit-token CLI labeling, and
the fail-closed/SSE/identical-401/CLI-warning tests. Independent review of #82:
APPROVE.

Residual non-blocking findings from the #82 review:

- A concurrent first-create race can return a token that differs from the
  persisted file (EEXIST + empty in-progress file). Both tokens are local and
  0600; no leak or bypass.
- `O_NOFOLLOW` ELOOP after an lstat→open swap is swallowed as "not found"
  rather than raised as `GatewayTokenFileError`; the credential is still not
  read or chmodded.
- Mode enforcement is skipped on Windows, documented as POSIX-only.
- The EEXIST/empty-file path and the explicit-token CLI label lack dedicated
  tests.

### GATEWAY-REVIEW — #64 has no independent review record

`#64` added 4,390 lines and 12 test files after the last roadmap audit.
Coverage on `34aef25` is 81.81% lines / 80.06% branches, up from the
pre-hardening 80.68% / 79.67% but still below the 82.40% historical baseline
recorded for `fa974ca`. The absolute difference is explained by the new
surface. `#76`, `#81`, and `#82` have independent APPROVE reviews; `#77` has a
REQUEST_CHANGES review corrected by #81. Reviews are recorded in
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

The offline gate is green on `34aef25` and the architecture matches its
contracts. The iMessage group-classification, gateway token-redirection, and
mesh release-ordering gaps are fixed by #81, #82, and #84. #85 then merged
restart recovery (P1-6) at `10e9f3c`; CI there reports 425 passed / 15 skipped
(440), 56 files, 82% lines, 80.05% branches (2746/3430), and 89.85% functions.
#87 merged the gateway token first-create/ELOOP fix at `5fbfb00`; CI on `main`
there reports 429 passed / 15 skipped (444), 58 files, 82.27% lines, 80.52%
branches (2779/3451), and 89.97% functions. #88 merged the iMessage group edge
and outbound fail-closed fix at `d3beb9c`; CI there reports 440 passed / 15
skipped (455), 58 files, 82.29% lines, 80.57% branches (2787/3459), and 89.97%
functions. #91 merged the re-landed live-suite determinism tests at `1dd426a`,
#92 merged the mesh queue branch tests and non-queued start cleanup at
`60bb9ae`, and #90 merged the group/1:1 thread-key separation at `8fa3a79`.
CI at `8fa3a79` reports 452 passed / 15 skipped (467), 58 files, 82.39% lines
(7837/9512), 80.97% branches (2814/3475), and 90.11% functions (693/769).
#93 recorded the cycle-4 checkpoint at `d539e25`, and #94 moved `main` to
`4cef6df` as an owner-merged, docs-only live-reference update. Cycle 5 then
merged #95 (exact offline counter assertions; `test/metrics.test.ts`) at
`f8554cc`, #96 (EEXIST winner-reuse and create-path ELOOP branch tests;
`test/gateway-token.test.ts`) at `ac1fd79`, and #97 (mesh node release on an
asynchronous non-queued rejection) at `9a0def3`. CI at `9a0def3` (run
`41615496540`) reports 455 passed / 15 skipped (470 tests, 58 files); the
coverage run reports 454 passed across 54 files, 82.42% statements/lines
(7844/9517), 81.01% branches (2817/3477), and 90.11% functions (693/769).
The cycle-5 checkpoint itself merged as #98 at `ab8e4bf` (docs-only). After
the checkpoint, #99 (mesh failure pump) merged at `6184a27`, #100 (outbox
permanent failure) at `55f0d09`, #101 (serve inbound iMessage loop) at
`2ae9740`, and #103 `[SUPER-AGENT][SUBSCRIPTION-FANOUT-TEST] Script the
many-to-many workers so fan-out no longer waits on a live model` at `5e5a28b`
(test-only `test/subscription.test.ts`, +4/−1), closing four residuals or test
gaps; the baseline for this record is `5e5a28b` and later merges are not
reflected. The remaining non-blocking work is tracked in the review log and the
current status lives in `docs/DEVELOPMENT_STATUS.md`.
