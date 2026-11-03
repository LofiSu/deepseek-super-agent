# Agent log

Append-only record of execution cycles. Each entry states what was observed,
decided, dispatched, verified, and merged. Do not rewrite history; correct it
with a new entry.

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
