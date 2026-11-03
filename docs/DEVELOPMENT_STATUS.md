# Development status

> Checkpoint: 2026-11-03 · `main` = `cb32a17`
> Source of truth: `git`, GitHub PRs/checks, and the evidence in
> `docs/PROJECT_AUDIT.md`. Do not trust this file without re-verifying.

## Main

| Field | Value |
|-------|-------|
| Commit | `cb32a17` |
| Last merged PR | #78 orchestration configuration |
| Open PRs at checkpoint | #74 (stale audit), #75 (project-state docs), #76 (gateway hardening), #77 (iMessage admission) |
| Required check | `typecheck and test` |
| Offline suite | 372 passed / 15 skipped (387 tests, 55 files) |
| Coverage | 80.68% statements/lines, 79.67% branches, 89.72% functions |

## Active workstreams

| Task | Priority | Branch | Owner | State |
|------|----------|--------|-------|-------|
| IMESSAGE-ADMISSION — iMessage fail-closed admission | P0 | `agent/imessage-admission` | implementer | PR #77, CI green, review REQUEST_CHANGES (group dedupe); fix in progress |
| P1-3 — mesh capacity/backpressure | P1 | `agent/P1-3-mesh-backpressure` | implementer | implementing; must also remove direct `Assignment.node` write |
| GATEWAY-HARDENING — gateway hardening | P1 | `agent/gateway-hardening` | implementer | PR #76, CI green, independent review APPROVE with non-blocking follow-ups |
| GATEWAY-TOKEN-SYMLINK — token file hardening | P1 | not created | unassigned | queued after #76 |
| AUDIT-REFRESH — refresh PR #74 audit | P2 | `docs/final-audit` | chief engineer | blocked on P1-3 docs edits |
| P1-6 — restart recovery | P1 | `agent/P1-6-restart-recovery` | unassigned | blocked on P1-3 |
| GATEWAY-REVIEW — review #64 surface | P2 | review only | review lead | #76 reviewed; #77 review returned changes |

## Completed this cycle

- Audited `cb32a17` in a detached worktree; typecheck, lint (217 tracked files),
  format, offline suite, and coverage.
- Reconciled `main` after PR #78 added the single-orchestrator, 3-agent,
  4-cycle, and `.super-agent/state.json` rules.
- Created and corrected the project-state docs: baseline, findings, plan,
  registry, log, review log, and ADRs.
- Corrected the audit's admission root cause: `admissionDeny` already runs
  before `addressed`; the default-open path comes from the absence of admission
  rules plus the always-`direct` marker.
- Recorded the first independent gateway review (APPROVE) and iMessage review
  (REQUEST_CHANGES, multi-chat group misclassification).

## Blockers

- PR #77 cannot merge until groupness is aggregated across all joined chat rows
  and missing chat metadata fails closed.
- P1-6 must wait for P1-3 because both change the Harness scheduler and runtime
  release hooks.
- PR #74 must wait for P1-3's `docs/MODULES.md`/`ROADMAP.md` edits to avoid a
  merge conflict; then rebase and refresh its evidence to `cb32a17`.
- Live model and real-channel acceptance remain operator-only; no credentials
  were used in this cycle.

## Next actions

1. Re-review the #77 fix; merge when green and clean.
2. Merge #76 if the review remains APPROVE and CI is green on the exact head.
3. Finish and review P1-3; then dispatch P1-6 and GATEWAY-TOKEN-SYMLINK.
4. Rebase and refresh PR #74 after P1-3.
5. Publish this project-state docs PR and re-run the full offline gate on `main`
   after each merge.
