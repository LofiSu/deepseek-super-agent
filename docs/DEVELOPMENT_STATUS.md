# Development status

> Checkpoint: 2026-11-03 · `main` = `d3beb9c`
> Source of truth: `git`, GitHub PRs/checks, and the evidence in
> `docs/PROJECT_AUDIT.md`. Do not trust this file without re-verifying.

## Main

| Field | Value |
|-------|-------|
| Commit | `d3beb9c` |
| Last merged PR | #88 iMessage group edge and outbound fail-closed fix |
| Merged in cycle 3 | #87 gateway token race, #88 iMessage group edges; both APPROVE |
| Merged in cycle 2 integration | #83 state reconciliation, #74 roadmap audit refresh, #85 restart recovery |
| Open PRs at checkpoint | #89 (this reconciliation, review corrections applied), #86 (stale/DIRTY; test-only salvage pending) |
| Required check | `typecheck and test` |
| Offline suite | 440 passed / 15 skipped (455 tests, 58 files) |
| Coverage | 82.29% statements/lines (7809/9489), 80.57% branches (2787/3459), 89.97% functions (691/768) |

The suite and coverage figures above are the `main` CI run at `d3beb9c`
(run `41600424146`). Earlier `main` runs: `5fbfb00` reported 429 passed / 15
skipped (444, 58 files) and 82.27% lines / 80.52% branches (2779/3451);
`10e9f3c` reported 425 passed / 15 skipped (440, 56 files) and 82% lines /
80.05% branches (2746/3430). A local `10e9f3c` run reported 80.09%
(2748/3431); that is a known one-branch V8 variance, not the CI figure.

## Active workstreams

| Task | Priority | Branch | Owner | State |
|------|----------|--------|-------|-------|
| STATE-RECONCILIATION — docs to `34aef25` | P1 | `docs/state-reconciliation` | chief engineer | merged (#83, `cecfba0`), APPROVE |
| AUDIT-REFRESH — roadmap audit | P2 | `docs/final-audit` | chief engineer | merged (#74, `299b908`), APPROVE |
| P1-6 — restart recovery | P1 | `agent/P1-6-restart-recovery` | implementer | merged (#85, `10e9f3c`), APPROVE |
| GATEWAY-TOKEN-RACE — first-create/ELOOP | P1 | `agent/gateway-token-race` | implementer | merged (#87, `5fbfb00`), security APPROVE |
| IMESSAGE-GROUP-EDGES — join-order/page/ambiguity | P1 | `agent/imessage-group-edge-tests` | implementer | merged (#88, `d3beb9c`), REQUEST_CHANGES → fix `890f238` → APPROVE |
| STATE-DOCS — cycle-3 reconciliation | P1 | `docs/cycle-3-status` | chief engineer | PR #89; docs REQUEST_CHANGES corrected; re-review pending |
| GATEWAY-REVIEW — review #64 surface | P2 | review only | review lead | #76/#81/#82/#84/#85/#87 APPROVE; #77 corrected |

## Completed this cycle

- Merged #88 after an independent review reproduced a group-to-1:1 outbound
  leak on the first head: group addresses still carried the sender `handle`,
  and the outbox adapter fell back to buddy mode without a `chatGuid`. The fix
  at `890f238` omits `handle` for groups and makes the adapter reject a group
  target without a chat guid before any send; five regressions fail against
  the pre-fix head. Delta re-review APPROVE; `main` CI is green at `d3beb9c`.
- Merged #87 after an independent security review returned APPROVE. The change
  removes the token-file truncate path, fails closed on an EEXIST race whose
  file holds no token, and raises `GatewayTokenFileError` on ELOOP in both the
  read and create paths. Both security tests fail on `10e9f3c`; `main` CI is
  green at `5fbfb00`. Residual non-blocking items: the EEXIST winner-reuse
  branch and the create-path ELOOP branch remain untested; a stale empty token
  file now blocks startup until it is removed manually.
- Merged #83 after an independent REQUEST_CHANGES → APPROVE cycle. The review
  caught stale Harness direct-write claims, a stale Task 1 status, a
  present-tense iMessage defect description, and a branch-coverage
  transcription error; all were corrected before merge.
- Merged #74 after two REQUEST_CHANGES → APPROVE cycles. Its base was refreshed
  onto `34aef25`, then refreshed again onto `cecfba0` after #83 landed, so the
  `34aef25` audit evidence is documented on `main`.
- Merged #85 after an independent review reproduced a same-process re-recovery
  bug, a missing RECOVERED prompt in the Worker turn, and unhandled launch
  failures. The final head has a per-Runtime recovery guard, prompt injection,
  launch-failure isolation, crash-boundary relaunch, and per-ticket isolation;
  all 11 regression tests fail on the pre-fix base.
- No live model or real-channel run was performed in this cycle.

## Blockers

- PR #86 (`test/live-suite-determinism`) is DIRTY against `main`; its docs
  portion is superseded by #83/#74 and its three test-only changes are to be
  re-landed on a fresh branch. Its recorded live Magpie run is operator-only
  evidence and was not reproduced here.
- Live model and real-channel acceptance remain operator-only; no credentials
  were used.
- Residual non-blocking items: gateway EEXIST winner-reuse and create-path
  ELOOP tests, mesh `queueState` branch tests, the malformed-doc partial-write
  edge in recovery (unreachable from valid state), the ambiguous-group thread
  key (`handle:<sender>`) which can share context between a group and a 1:1
  conversation from the same sender, and fail-closed group tickets that still
  retry in the outbox before landing in `failed`.
- `serve` still has no inbound channel loop; this remains a documented boundary.

## Next actions

1. Re-review PR #89 after the docs corrections; merge it once its statements
   match `git` and GitHub.
2. Salvage PR #86's test-only changes on a fresh branch, then close the stale
   PR with a pointer to the replacement.
3. Update `.super-agent/state.json` at each checkpoint; only the main
   orchestrator writes it.
