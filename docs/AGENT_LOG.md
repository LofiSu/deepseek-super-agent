# Agent log

Append-only record of execution cycles. Each entry states what was observed,
decided, dispatched, verified, and merged. Do not rewrite history; correct it
with a new entry.

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
