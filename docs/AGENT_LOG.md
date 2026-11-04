# Agent log

Append-only record of execution cycles. Each entry states what was observed,
decided, dispatched, verified, and merged. Do not rewrite history; correct it
with a new entry.

## 2026-11-04 — Cycle 5 (post-cap follow-ups merged; checkpoint)

### Observed

- The previous orchestrator process ended after merging #95–#97 without a
  checkpoint: `.super-agent/state.json` still said `next_action: integrate`
  with PR #97 "awaiting refreshed CI", and the docs still described `8fa3a79`.
  The two peer sessions were idle for more than 20 hours.
- `main` is `9a0def3`: #94 (owner, docs-only live reference run), #95, #96,
  and #97 merged. #97 merged at 09:59:34Z with `typecheck and test` green and
  zero unresolved review threads.
- Local `9a0def3` gate: `tsc --noEmit`, `pnpm lint` (227 files),
  `pnpm format:check` clean; offline suite 443 passed / 53 files.

### Decided

- Resume the loop in this session under the owner's explicit continuation past
  the four-cycle cap; record the override rather than silently reset it.
- Checkpoint cycle 5 before dispatching cycle 6, so `main` documents the state
  the next PRs branch from.
- Cycle 6 scope: SERVE-CHANNEL-LOOP (P1) and OUTBOX-PERMANENT-FAILURE (P2),
  the two highest-value residuals that do not share files.

### Verified

- #95 (metrics assertions) and #96 (gateway token EEXIST/ELOOP tests) are
  test-only; #97 releases the reserved mesh node when a non-queued Worker turn
  rejects asynchronously and records `[harness] worker failed ...`.
- Reviewed heads: #95 `11313cd`, #96 `b19e490`, #97 `f18e16f`; merged as
  `f8554cc`, `ac1fd79`, `9a0def3`.
- Branch protection was not bypassed; no live model or real-channel run.

### Pending

- Review the two cycle-6 PRs; write the cycle-6 checkpoint.

## 2026-11-03 — Cycle 4 checkpoint (follow-ups merged; session at cycle cap)

### Observed

- The previous session process ended while three implementers and three
  reviewers were running. On restart, the merged PRs (#87–#89) were intact; the
  lost worktrees were recreated from their pushed branches, and the three
  cycle-4 reviewers were re-dispatched fresh. No result was assumed from the
  interrupted run.
- #90 merged at `8fa3a79` after an independent APPROVE: group thread keys are
  `chat:`/`group:`/`group-unknown:` and can never equal a 1:1 `handle:` key;
  positive-group guids and identifiers aggregate independently. Three
  behavioral tests fail on the pre-fix base; the "guid thread" and "1:1 keys"
  tests are regression guards.
- #91 merged at `1dd426a` after an independent APPROVE, re-landing the four
  test-only determinism changes from #86. The default MockModel refusal still
  holds; only the credential sentinel opts in explicitly. #86 was closed as
  superseded; its docs conflict with `main` and its live-run record remains in
  PR history without being reproduced.
- #92 merged at `60bb9ae` after an independent APPROVE: six previously
  untested `queueState()` skip branches now have direct tests, and a
  synchronous throw on the non-queued start path releases the active marker
  and mesh node instead of rejecting the launch. The cleanup test fails on the
  base; the branch tests were mutation-verified.
- `main` CI at `8fa3a79` (run `41605279682`): 452 passed / 15 skipped (467),
  58 files; 82.39% statements/lines (7837/9512), 80.97% branches (2814/3475),
  90.11% functions (693/769).

### Decided

- Close #86 rather than rebase; the test-only changes are on `main` via #91,
  and its docs record cannot merge as-is.
- Accept these residual non-blocking items for a later session: gateway EEXIST
  winner-reuse and create-path ELOOP tests; the tautological replacement
  assertions in `test/metrics.test.ts`; the unchanged async-rejection node
  release on the non-queued path; fail-closed group outbox retry noise.
- Stop at the four-cycle session cap.

### Verified

- All four cycle-4 review verdicts (including #89) were independent and
  recorded; every merge had green `typecheck and test` on its exact head.
- No live model or real-channel run; no credentials used.

### Pending

- Next session: pick from `docs/MASTER_PLAN.md` "Next sessions" and start from
  current `main`. Do not reopen merged PRs.

## 2026-11-03 — Cycle 3 checkpoint 2 (gateway merged; iMessage fix and docs corrected)

### Observed

- The checkpoint-1 entry above first stated 80.09% branches for `10e9f3c`. The
  CI job (`125790452074`) displays 80.05% (2746/3430); the entry was corrected
  in place before merge. The 80.09% figure was a local V8 variance, not CI.
- #87 merged at `5fbfb00` after an independent security review APPROVE. The
  EEXIST race now fails closed instead of truncating the winner's file, ELOOP
  raises `GatewayTokenFileError` on read and create, and both security tests
  fail on `10e9f3c`. `main` CI at `5fbfb00` (run `41599524227`) is green:
  429 passed / 15 skipped (444), 58 files; 82.27% statements/lines, 80.52%
  branches (2779/3451), 89.97% functions.
- PR #88's review reproduced a group-to-1:1 outbound leak: a group address
  still carried the sender `handle`, and the outbox adapter fell back to buddy
  mode when no `chatGuid` existed. A fix at `890f238` omits `handle` for groups
  and makes the adapter reject a group target without a chat guid. The delta
  re-review returned APPROVE; #88 merged at `d3beb9c`. `main` CI there (run
  `41600424146`) is green: 440 passed / 15 skipped (455), 58 files; 82.29%
  statements/lines, 80.57% branches (2787/3459), 89.97% functions.
- PR #89's docs review returned REQUEST_CHANGES for a CI coverage misquote and
  an open-PR snapshot that claimed "none" while #86/#88/#89 were open. The
  docs were refreshed to `5fbfb00` and the duplicate #74 record marked
  superseded.

### Decided

- The iMessage fix keeps the ambiguous-group thread-key issue out of scope; it
  is recorded as IMESSAGE-THREAD-KEY for a later branch rather than widening
  the security PR.
- #86 is stale/DIRTY; its docs portion is superseded and only its three
  test-only determinism changes are to be salvaged on a fresh branch.

### Verified

- No live model or real-channel run. All figures above come from the named CI
  run logs and `git`/GitHub state.

### Pending

- Scoped re-review of PR #89; merge it only on green CI at the exact head.
- Salvage #86's test-only determinism changes on a fresh branch, then close the
  stale PR with a pointer to the replacement.

## 2026-11-03 — Cycle 3 checkpoint 1 (cycle 2 integrated; edge work dispatched)

### Observed

- #83 merged at `cecfba0` after the scoped re-review APPROVE; all five blocking
  doc findings and three CodeRabbit threads were resolved.
- #74 merged at `299b908` after the final coverage-figure fix and delta APPROVE.
  `main` now carries the `34aef25` audit evidence.
- #85 merged at `10e9f3c` after the re-review APPROVE. The review reproduced a
  same-process re-recovery bug; the final head has a per-Runtime guard, prompt
  injection, launch-failure isolation, crash-boundary relaunch, and per-ticket
  isolation. All 11 regression tests fail on the pre-fix base.
- `main` CI at `10e9f3c`: `typecheck and test` success; 425 passed, 15 skipped
  (440), 56 files; coverage 82% lines, 80.05% branches (2746/3430), 89.85%
  functions. A local run on the same commit reported 80.09% branches
  (2748/3431), a one-branch V8 variance.

### Decided

- Accept ADR-004 as implemented. The at-least-once boundary and the
  malformed-doc partial-write edge stay documented as non-blocking.
- Start cycle 3 with two disjoint security-edge tasks: iMessage group join/page/
  ambiguity coverage and gateway first-create/ELOOP hardening.
- Do not reopen merged PRs for non-blocking follow-ups; new branches only.

### Verified

- `main` CI green at `10e9f3c`; no live model or real-channel run.
- Both cycle-3 branches are isolated; no file overlap with each other or docs.

### Pending

- PRs and independent reviews for IMESSAGE-GROUP-EDGES and GATEWAY-TOKEN-RACE.

## 2026-11-03 — Cycle 2, checkpoint 2 (state review corrected; P1-6 in review)

### Observed

- PR #83's independent review returned REQUEST_CHANGES on five stale/incorrect
  statements: the pre-#79 Harness direct-write claim in two docs, a stale Task 1
  "post-merge fix pending", a present-tense default-open iMessage description,
  and a branch-coverage transcription (80.05% local vs 80.06% CI on `34aef25`).
- PR #74's refreshed review returned REQUEST_CHANGES: its revision row claimed
  "#75–#84 merged" while #83 was open, and the `34aef25` evidence was not yet in
  `docs/PROJECT_AUDIT.md` on `main`.
- P1-6 implementation opened PR #85 (`4b3ad35`) with six tests and a clean CI
  run; the orchestrator review found the RECOVERED prompt is persisted but not
  included in the relaunched Worker prompt.

### Corrected

- #83 head `e0bee0f` fixes all five findings; scoped re-review returned APPROVE.
  CI passed on the exact head (414 passed / 15 skipped).
- #74 head `3119369` corrects the merge-range claim and labels; it will merge
  `main` after #83 lands so the audit evidence is documented on `main`.

### Verified

- `pnpm typecheck`, `pnpm lint` (224 files), and `pnpm format:check` pass on the
  corrected docs branches.
- No code, credential, or live-model changes were made in either docs PR.

### Pending

- Merge #83; refresh and re-review #74.
- Fix the P1-6 RECOVERED-prompt gap and re-review #85.

## 2026-11-03 — Cycle 2, checkpoint 1 (corrections merged)

### Observed

- #81 merged at `f4ba77a` after an independent APPROVE review. The multi-chat
  group dedupe, missing-metadata, handle-trim, and schema-error findings are
  fixed. Residual: two test gaps and an ambiguous group-id fallback.
- #82 merged at `1c165ef` after an independent APPROVE review. Symlink,
  hard-link, and non-regular token paths are rejected; fail-closed/SSE/401/CLI
  tests are added. Residual: first-create race, ELOOP fallback, two test gaps.
- #79 merged at `1dc9500` before its review completed. The review returned
  REQUEST_CHANGES: release hooks fire before terminal persistence, so a queued
  Worker can start after its ticket ended. #84 merged at `34aef25` after an
  independent APPROVE review; the pump now waits for committed state and
  revalidates before start.
- `34aef25` gates: typecheck/lint (224 files)/format pass; 414 passed,
  15 skipped (429); coverage 81.81% lines, 80.06% branches, 89.77% functions.
- `#80` merged as a docs checkpoint at `2c02f4b`; its P1-3 statement was stale
  before merge and is superseded here.

### Decided

- Merge #81 and #82 only after clean reviews and green CI; both are now merged.
- Do not call the mesh queue correct until #84 merges; it is now merged.
- Refresh PR #74 after #84, not before.

### Verified

- Independent reviews: #81 APPROVE, #82 APPROVE, #79 REQUEST_CHANGES,
  #84 APPROVE.
- The #84 regression fails on the pre-fix base and passes on the fix.
- No live model or real-channel writes were performed.

### Pending

- Rebase and refresh PR #74.
- Dispatch P1-6.

## 2026-11-03 — Cycle 2 (deployment and review reconciliation)

> Preserved verbatim from `main`; the checkpoint entries above supersede its
> status but do not replace this record.

### Observed

- `main` advanced from `bb11c96` to `03a4c02`; four PRs were open (#74–#77).
- #75 was BEHIND and blocked by six CodeRabbit threads; #76/#77 were BEHIND.
- The orchestration config did not exist yet (no CLAUDE.md, agents, skill, or
  Stop guard).

### Decided

- Deploy the orchestration layer on its own branch/PR, not on top of the docs
  branch.
- Treat the stale PR #74 as blocked; refresh it only after P1-3 edits the same
  docs.
- Merge #75/#76/#77 only after required checks, independent review, and
  resolving every review thread.

### Executed

- #78: CLAUDE.md, five agents, autonomous-engineering skill, Stop guard,
  gitignore rules. Nine guard cases tested.
- #75: fixed six review findings in `deed616`, answered/resolved all threads.
- #76 and #77: reviewed against the audit findings; both merged.

### Verified

- Offline suite on `03a4c02`: 376 passed / 50 files.
- CI green on every merged PR; branch protection was not bypassed.

### Pending

- P1-3 is unfinished (worktree edits, no commit).
- AUDIT-REFRESH after P1-3; P1-6 after P1-3; GATEWAY-REVIEW coverage.

## 2026-11-03 — Cycle 1, checkpoint 3 (integration at `03a4c02`)

### Observed

- Another session integrated #75, #76, and #77 into `main` at `08ea78f`,
  `aae182c`, and `03a4c02`. CI was green on each exact head.
- #77 was merged despite the independent REQUEST_CHANGES verdict on multi-chat
  group dedupe. The merged code still classifies a message joined to a 1:1 chat
  first and a group chat second as 1:1, and missing chat metadata defaults to
  1:1.
- #75 merged at `deed616`, before the final reconciliation commit `bdce7ea`.
  The merged docs still carry the `bb11c96` baseline and stale counts.
- #76 merged the gateway hardening with an APPROVE review. The symlink
  redirection and missing fail-closed/SSE/401 tests remain.
- P1-3 finished as PR #79 with Engine-owned placement; independent review is
  running.
- `03a4c02` gates: typecheck/lint (224 files)/format pass; 388 passed,
  15 skipped (403); coverage 81.00% lines, 79.84% branches, 89.37% functions.

### Decided

- Treat the #77 merge as a process incident. Open the corrective PR #81
  immediately; do not call the iMessage surface fail-closed until it merges.
- Ship the reconciled docs in a new PR from `main`; do not rewrite history or
  force-push a merged branch.
- Review #79 and the gateway token follow-up independently before merge.

### Dispatched

- IMESSAGE-GROUP-FIX: #81, aggregate groupness across all joined chats.
- GATEWAY-TOKEN-SYMLINK: symlink/non-regular token rejection and
  security-branch tests.
- P1-3 review: independent concurrency review of #79.

### Verified

- #81 reports CI green and 395 passed / 15 skipped; independent review pending.
- No live model or real-channel writes were performed.

### Pending

- Merge #81 and #79 only after clean independent review.
- Merge the gateway token follow-up.
- Then P1-6 and PR #74 refresh.

## 2026-11-03 — Cycle 1, checkpoint 2 (main advanced to `cb32a17`)

### Observed

- PR #78 merged while the first batch was running, adding the single-orchestrator
  contract, 3-implementation-agent cap, 4-cycle session cap, and
  `.super-agent/state.json` protocol. `main` is now `cb32a17`.
- #76 and #77 both merged current `main`; their effective diffs stayed limited
  to the assigned files. CI is green on both heads.
- Independent gateway review returned **APPROVE** with non-blocking follow-ups:
  token-file symlinks are followed, and fail-closed/SSE/identical-401 tests are
  missing.
- Independent iMessage review returned **REQUEST_CHANGES**: a message joined to
  multiple chats is deduped to the first row, so a group message can still be
  classed 1:1 and marked `direct`; missing chat metadata also defaults to 1:1.
- P1-3 implementer completed PR #79: bounded queue, FIFO pump, explicit shutdown
  drain, metrics, and Engine-owned `Assignment.node` placement. Full suite
  reported 380 passed / 15 skipped.
- Fresh `cb32a17` gates: typecheck/lint (217 files)/format pass; 372 passed,
  15 skipped (387); coverage 80.68% statements/lines, 79.67% branches,
  89.72% functions.

### Decided

- Keep the project-state docs in their own PR; do not count them as a fourth
  implementation task.
- Move AUDIT-REFRESH from Cycle 1 to Cycle 2: it shares `docs/ROADMAP.md` and
  `docs/MODULES.md` with P1-3 and must follow it.
- Record the `Assignment.node` write as a known deviation from "Engine is the
  only writer"; P1-3 now removes it through `Engine.assignmentPlaced`.
- Do not merge #77 until groupness is aggregated across all joined chat rows and
  missing metadata fails closed.
- Accept #76 on its APPROVE verdict; track symlink hardening and missing
  security-branch tests as GATEWAY-TOKEN-SYMLINK.

### Dispatched

- iMessage fix round on `agent/imessage-admission`: aggregate group metadata,
  trim the handle before SQL, fail clearly on old schema, add the missing
  fixtures.

### Verified

- Docs corrections and the new baseline are in this PR.
- No live model or real-channel writes were performed.

### Pending

- Re-review #77 and review #79.
- Merge #76, then dispatch GATEWAY-TOKEN-SYMLINK.
- P1-6 and AUDIT-REFRESH after P1-3 merges.
- Update `.super-agent/state.json` at the next checkpoint.

## 2026-11-03 — Cycle 1

### Observed

- `main` at `bb11c96`; clean tree; origin in sync.
- One open PR: #74, docs-only, `MERGEABLE`, `BEHIND`, CI green, base `fa974ca`.
- Issues disabled. Branch protection requires `typecheck and test` and
  conversation resolution; admins enforced.
- Offline gate: typecheck/lint/format pass; 372 passed, 15 skipped; coverage
  80.68% lines / 79.69% branches / 89.72% functions.
- #64 merged 4,390 lines of iMessage/gateway code after the last audit.

### Decided

- Do not merge PR #74 as-is: its audit evidence predates #64. Refresh it after
  P1-3's docs edits.
- Treat iMessage default-open admission as IMESSAGE-ADMISSION (security), not a docs nit.
- Enforce mesh capacity before attempting restart recovery, because both change
  the Harness scheduler.
- Keep the Engine as the only domain writer; the mesh queue stays in the
  Harness and is explicitly process-local.

### Dispatched

- IMESSAGE-ADMISSION iMessage admission — `agent/imessage-admission`.
- P1-3 mesh backpressure — `agent/P1-3-mesh-backpressure`.
- GATEWAY-HARDENING gateway hardening — `agent/gateway-hardening`.

### Verified

- Baseline commands and outputs are recorded in `docs/PROJECT_AUDIT.md`.
- No live model or real-channel writes were performed.

### Pending

- Implementer reports and PR URLs.
- Independent review of each PR.
- Rebase/refresh PR #74.
- P1-6 after P1-3 merges.

## 2026-11-03 — Cycle 0 (initial audit)

- Located the canonical clone at the repository root.
- Confirmed GitHub authentication and Node/pnpm versions.
- Read `PLAN.md` structure, `docs/ROADMAP.md` status board, module tree, and the
  new gateway/iMessage code.
- Created the project-state documents and the master plan.
