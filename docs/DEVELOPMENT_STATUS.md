# Development status

> Checkpoint: 2026-11-03 · `main` = `8fa3a79`
> Source of truth: `git`, GitHub PRs/checks, and the evidence in
> `docs/PROJECT_AUDIT.md`. Do not trust this file without re-verifying.

## Main

| Field | Value |
|-------|-------|
| Commit | `8fa3a79` |
| Last merged PR | #90 iMessage group/1:1 thread-key separation |
| Merged in cycle 4 | #90 thread keys, #91 live-suite test salvage, #92 mesh queue tests and non-queued start cleanup; all APPROVE |
| Merged in cycle 3 | #87 gateway token race, #88 iMessage group edges, #89 cycle-3 reconciliation; all APPROVE |
| Merged in cycle 2 integration | #83 state reconciliation, #74 roadmap audit refresh, #85 restart recovery |
| Open PRs at checkpoint | this cycle-4 checkpoint PR only |
| Required check | `typecheck and test` |
| Offline suite | 452 passed / 15 skipped (467 tests, 58 files) |
| Coverage | 82.39% statements/lines (7837/9512), 80.97% branches (2814/3475), 90.11% functions (693/769) |

The suite and coverage figures above are the `main` CI run at `8fa3a79`
(run `41605279682`). Earlier `main` runs: `d3beb9c` reported 440 passed / 15
skipped (455, 58 files) and 82.29% lines / 80.57% branches (2787/3459);
`5fbfb00` reported 429/15 (444) and 82.27% / 80.52% (2779/3451); `10e9f3c`
reported 425/15 (440, 56 files) and 82% / 80.05% (2746/3430). A local
`10e9f3c` run reported 80.09% (2748/3431), a known one-branch V8 variance.

## Active workstreams

| Task | Priority | Branch | Owner | State |
|------|----------|--------|-------|-------|
| STATE-RECONCILIATION — docs to `34aef25` | P1 | `docs/state-reconciliation` | chief engineer | merged (#83, `cecfba0`), APPROVE |
| AUDIT-REFRESH — roadmap audit | P2 | `docs/final-audit` | chief engineer | merged (#74, `299b908`), APPROVE |
| P1-6 — restart recovery | P1 | `agent/P1-6-restart-recovery` | implementer | merged (#85, `10e9f3c`), APPROVE |
| GATEWAY-TOKEN-RACE — first-create/ELOOP | P1 | `agent/gateway-token-race` | implementer | merged (#87, `5fbfb00`), security APPROVE |
| IMESSAGE-GROUP-EDGES — join-order/page/ambiguity | P1 | `agent/imessage-group-edge-tests` | implementer | merged (#88, `d3beb9c`), APPROVE after fix |
| STATE-DOCS — cycle-3 reconciliation | P1 | `docs/cycle-3-status` | chief engineer | merged (#89, `ed8980d`), APPROVE after corrections |
| IMESSAGE-THREAD-KEY — group vs 1:1 context keys | P1 | `agent/imessage-thread-key` | implementer | merged (#90, `8fa3a79`), APPROVE |
| LIVE-SUITE-SALVAGE — re-land #86 test-only changes | P2 | `test/live-suite-salvage` | implementer | merged (#91, `1dd426a`), APPROVE; #86 closed |
| MESH-QUEUE-TESTS — skip branches and start cleanup | P2 | `agent/mesh-queue-tests` | implementer | merged (#92, `60bb9ae`), APPROVE |
| GATEWAY-REVIEW — review #64 surface | P2 | review only | review lead | #76/#81/#82/#84/#85/#87 APPROVE; #77 corrected |

## Completed this cycle

- Merged #90 after an independent review APPROVE. Group thread keys are now
  namespaced away from 1:1 keys (`chat:` / `group:` / `group-unknown:` vs
  `handle:`), so an ambiguous group cannot share ticket context with a 1:1
  conversation from the same sender. Positive-group guids and identifiers are
  aggregated independently, so an identifier-only row cannot hide a later
  guid. Three behavioral tests fail on the pre-fix base; CI green at `8fa3a79`.
- Merged #91, re-landing the four test-only determinism changes from stale
  #86 on current `main`. The default MockModel refusal is unchanged; only the
  credential sentinel opts in explicitly. #86 was closed as superseded (its
  docs conflict with current `main`; its live-run record stays in PR history
  and was not reproduced).
- Merged #92, covering the six previously untested `queueState()` skip branches
  and adding a synchronous-throw cleanup for the non-queued start path. The
  cleanup test fails on the base with a rejected launch; the branch tests are
  mutation-verified. CI green at `60bb9ae`.
- No live model or real-channel run was performed in this cycle.

## Blockers

- The session cycle budget is exhausted (4 completed cycles). No further
  implementation work is dispatched in this session; this checkpoint is the
  recovery record for the next one.
- Live model and real-channel acceptance remain operator-only; no credentials
  were used.
- Residual non-blocking items: gateway EEXIST winner-reuse and create-path
  ELOOP branch tests; a stale empty gateway token file blocks startup until
  removed manually; the delayed non-queued async-rejection node release
  (unchanged from base); the `metrics.test.ts` replacement assertions for
  `speculate.deliver`/`watchdog.idle` are tautological under a zeroed counter
  map; fail-closed group tickets still enqueue outbox rows that retry to
  `failed`; ambiguous groups from one sender across distinct chats still share
  `group-unknown:<handle>` (never with 1:1).
- `serve` still has no inbound channel loop; this remains a documented boundary.

## Next actions

1. Next session: reconcile this checkpoint and pick from the residual list;
   gateway branch tests and the metrics assertion strength are the smallest.
2. Do not reopen merged PRs. Branch from current `main` for each fix.
3. Update `.super-agent/state.json` at each checkpoint; only the main
   orchestrator writes it.
