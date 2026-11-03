# Project audit — 2026-11-03

> Audit base: `main` at `03a4c02` (`fix(imessage): fail closed admission and
> gate group chats (#77)`). Commands were run in a detached worktree at
> `origin/main`; the primary clone contained unrelated uncommitted WIP and was
> not used. This audit supersedes the stale `fa974ca` evidence in PR #74 and
> the earlier `bb11c96`/`cb32a17` checkpoints.

## 1. Repository state

| Item | Observation |
|------|-------------|
| Branch | `main`, clean in the detached audit worktree |
| HEAD | `03a4c02` |
| Remote | `git@github.com:LofiSu/deepseek-super-agent.git` |
| Last merged PR | **#77** iMessage fail-closed admission (merged 2026-11-03T06:12:32Z) |
| Merged this cycle | #75 project-state docs (`08ea78f`), #76 gateway hardening (`aae182c`), #77 iMessage admission (`03a4c02`) |
| Open PRs at checkpoint | **#79** (`agent/P1-3-mesh-backpressure`) and this documentation reconciliation PR |
| Issues | GitHub Issues disabled |
| Branch protection | required check `typecheck and test`; strict; admins enforced; conversation resolution required |
| Node / pnpm | Node v22.23.4 / pnpm 9.15.9 |
| Package scripts | `lint`, `format:check`, `typecheck`, `test`, `test:coverage`, `demo`, `demo:local`, `demo:feishu`, `bench:bakeoff` |

`#78` added the project orchestration contract in `CLAUDE.md`, agent
definitions, a stop guard, and the `autonomous-engineering` skill. It makes the
main session the only orchestrator, caps the validating pipeline at three
implementation agents, caps a session at four completed cycles, and requires
the main session alone to write `.super-agent/state.json`.

`#75` merged the first project-state checkpoint, but its final reconciliation
commit (`bdce7ea`) landed after the merge and is not on `main`. This PR carries
the reconciled state forward; it does not rewrite the merged commit.

## 2. Verified quality gates

```text
pnpm typecheck                                         exit 0
pnpm lint                                              lint ok (224 tracked files)
pnpm format:check                                      exit 0
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run   388 passed, 15 skipped (403)
                                                      55 files: 52 with passing tests,
                                                      3 fully skipped
pnpm test:coverage                                     387 passed, 51 files
                                                       statements 81.00% (7280/8987)
                                                       branches   79.84% (2528/3166)
                                                       functions  89.37% (656/734)
                                                       lines      81.00% (7280/8987)
```

File-count detail for the plain offline run:

- 52 files execute at least one passing test. `test/live-demo.test.ts` is one of
  them: it passes one offline test and skips three live tests.
- 3 files are fully skipped: `test/demos-real-channels.test.ts` (3 tests),
  `test/live-e2e.test.ts` (7), and `test/team-live.test.ts` (2).
- The 15 skipped tests are the live model and real-channel suites. No live model
  or real-channel acceptance run was performed in this audit.

Coverage note: the earlier `bb11c96` run reported 79.69% branches
(2469/3098), and the `cb32a17` run reported 79.67% (2465/3094). The current
`03a4c02` run reports 79.84% (2528/3166); it includes the new gateway and
iMessage tests from #76/#77. The figures above are the audited `03a4c02`
numbers.

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
decision. PR #79 moves placement to `Engine.assignmentPlaced`; until it merges,
the accurate claim is "Engine owns domain transitions", not "Engine is the only
writer". No new direct writes are permitted.

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
trigger work. PR #77 merged the fail-closed gate, but its independent review
returned REQUEST_CHANGES before merge: a message joined to multiple chats is
deduped to one row, so a group message can still be classified as 1:1. Missing
chat metadata also defaults to 1:1 through the `LEFT JOIN`. The merged code
therefore does not yet satisfy "a group message is never `direct`". A follow-up
PR aggregates groupness across all `chat_message_join` rows, treats missing
metadata as unknown/group, trims the handle before SQL, and adds the missing
fixtures.

### P1-3 — Worker-mesh capacity is advisory

`Harness.launch` logs `[mesh] ... capacity-full` and runs the Worker anyway.
`WorkerMeshRegistry` correctly reports no free node, but no scheduler consumes
that signal on `main`. With `DS_AGENT_MESH_CAPACITY=1`, two Workers can run
concurrently. PR #79 is open with a bounded queue and Engine-owned placement;
its independent review is in progress.

### P1-6 — No restart replay

`Runtime.start` starts the daemon and pending assessments but does not scan for
interrupted assignments. A killed process leaves an assignment `running` until
the watchdog (or forever if the watchdog is not run). `serve` explicitly
documents that in-flight turns are not reconstructed. This is scheduled after
the mesh change because both touch `Harness.launch`/`drain` and runtime release.

### GATEWAY-HARDENING — Gateway auth/exposure edges

`#76` merged the following fixes: constant-time bearer comparison, empty-token
refusal, a non-loopback exposure warning, token-file `0600` repair with a
fail-closed error, `nosniff`/`no-store` headers, and no token in the dashboard.
Residual findings:

- Token-file reads and chmods follow symlinks. A writable `DS_AGENT_HOME` can
  redirect the credential; the GATEWAY-TOKEN-SYMLINK follow-up rejects
  symlinks/non-regular files, uses `O_NOFOLLOW`, and adds the missing security
  tests.
- Mode enforcement is skipped on Windows; this is documented as a POSIX-only
  guarantee.
- The CLI can label a token file that was not written when `--token` or
  `DS_AGENT_GATEWAY_TOKEN` supplied the credential.

### GATEWAY-REVIEW — #64 has no independent review record

`#64` added 4,390 lines and 12 test files after the last roadmap audit.
Coverage on `03a4c02` is 81.00% lines / 79.84% branches, up from the
pre-hardening 80.68% / 79.67% but still below the 82.40% historical baseline
recorded for `fa974ca`. The absolute difference is explained by the new
surface. `#76` now has an independent APPROVE review; `#77` has a
REQUEST_CHANGES review with a post-merge fix follow-up. Reviews are recorded in
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

The offline gate is green on `03a4c02` and the architecture still matches its
contracts, with the documented `Assignment.node` deviation until #79 merges.
The highest-value work is not new features: it is closing the merged iMessage
group-classification gap, making mesh capacity real, adding restart recovery,
and completing the gateway token-file hardening.
