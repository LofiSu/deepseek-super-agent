# Development status

> Checkpoint: 2026-11-04 · baseline `main` = `5e5a28b`
> Source of truth: `git`, GitHub PRs/checks, and the evidence in
> `docs/PROJECT_AUDIT.md`. Do not trust this file without re-verifying; later
> merges after this baseline are not reflected.

## Main

| Field | Value |
|-------|-------|
| Commit | `5e5a28b` |
| Last merged PR | #103 SUBSCRIPTION-FANOUT-TEST |
| Merged in cycle 5 | #94 live reference run (owner, outside this session), #95/#96/#97 test hardening (reviewed APPROVE), #98 checkpoint (docs) |
| Merged after the cycle-5 checkpoint | #99 MESH-FAILURE-PUMP (`6184a27`), #100 OUTBOX-PERMANENT-FAILURE (`55f0d09`), #101 SERVE-CHANNEL-LOOP (`2ae9740`), #103 SUBSCRIPTION-FANOUT-TEST (`5e5a28b`) |
| Merged in cycle 4 | #90 thread keys, #91 live-suite test salvage, #92 mesh queue tests; all APPROVE |
| Merged in cycle 3 | #87 gateway token race, #88 iMessage group edges, #89 cycle-3 reconciliation; all APPROVE |
| Open PRs at checkpoint | #102 this cycle-5 docs follow-up; #104 cycle-6 checkpoint (open, not reviewed or merged) |
| Required check | `typecheck and test` |
| Offline suite | 455 passed / 15 skipped (470 tests, 58 files) at `9a0def3` |
| Coverage | 82.42% statements/lines (7844/9517), 81.01% branches (2817/3477), 90.11% functions (693/769) at `9a0def3` |

The suite and coverage figures above are the `main` CI run at `9a0def3`
(run `41615496540`), the last full product baseline before the docs-only
checkpoint; the coverage job reported 454 passed across 54 files. A post-merge
`main` CI at `6184a27` (run `41791336153`) reported 456 passed / 15 skipped
(471 tests), statements/lines 82.42% (7846/9519), branches 81.03% (2820/3480),
and functions 90.11%. #100, #101, and #103 added tests afterward, so the current
`main` count is higher and is left to their CI runs rather than restated here.
CI runs the full suite with the 15 live tests skipped when no provider
credential is present. A local cycle-5 gate on `9a0def3` with the live test
files excluded reported 443 passed / 53 files;
it is not the CI baseline.

## Active workstreams

| Task | Priority | Branch | Owner | State |
|------|----------|--------|-------|-------|
| GATEWAY-TOKEN-TESTS — EEXIST/ELOOP branches | P2 | `agent/gateway-token-tests` | implementer | merged (#96, `ac1fd79`), APPROVE |
| METRICS-ASSERTIONS — offline counter assertions | P2 | `agent/metrics-assertions` | implementer | merged (#95, `f8554cc`), APPROVE |
| MESH-ASYNC-RELEASE — async rejection node release | P2 | `agent/mesh-async-release` | implementer | merged (#97, `9a0def3`), APPROVE |
| MESH-FAILURE-PUMP — pump queued Workers after a failed release | P2 | `agent/mesh-failure-pump` | implementer | merged (#99, `6184a27`), APPROVE |
| SERVE-CHANNEL-LOOP — inbound iMessage loop for `serve` | P1 | `agent/serve-imessage-loop` | implementer | merged (#101, `2ae9740`) |
| OUTBOX-PERMANENT-FAILURE — stop retrying unroutable sends | P2 | `agent/outbox-permanent-failure` | implementer | merged (#100, `55f0d09`) |
| SUBSCRIPTION-FANOUT-TEST — deterministic many-to-many workers | P2 | `debug/subscription-timeout` | implementer | merged (#103, `5e5a28b`) |
| GATEWAY-REVIEW — review #64 surface | P2 | review only | review lead | #76/#81/#82/#84/#85/#87/#90/#95/#96/#97 APPROVE; #77 corrected |
| CYCLE-5-CHECKPOINT — this checkpoint | P1 | `docs/cycle-5-checkpoint` | chief engineer | merged (#98, `ab8e4bf`) |
| CYCLE-6-CHECKPOINT — cycle-6 record | P1 | `docs/cycle-6-checkpoint` | chief engineer | PR #104 open; not reviewed or merged |

## Completed this cycle (Cycle 5)

- Resumed after the cycle-4 checkpoint with the owner's explicit continuation
  past the four-cycle cap (recorded in `.super-agent/state.json`).
- Merged #95: the three live-relaxed counter assertions are now deterministic
  under the offline MockModel and keep the live fallback.
- Merged #96: direct tests for the gateway-token EEXIST winner-reuse path and
  the create-path ELOOP failure. The EEXIST test does not fail on pre-#87
  `10e9f3c` because `if (raced) return raced` pre-dates #87 and behaves
  identically; it is mutation-verified instead (`return token` mutation fails).
  The create-path ELOOP test does fail on `10e9f3c` with the raw `ELOOP` error.
- Merged #97: a non-queued Worker turn that rejects asynchronously now returns
  the reserved mesh node and logs `[harness] worker failed ...`, matching the
  synchronous-throw and queued paths.
- Final `main` `9a0def3` CI (run `41615496540`) succeeded: offline suite
  455 passed / 15 skipped (470 tests, 58 files); coverage run 454 passed,
  54 files; statements/lines 82.42% (7844/9517), branches 81.01% (2817/3477),
  functions 90.11% (693/769).
- Merged the cycle-5 checkpoint as #98 at `ab8e4bf` (docs-only).
- After the checkpoint, #99 (pump queued Workers after a failed non-queued
  release) merged at `6184a27`, #100 (outbox permanent failure) merged at
  `55f0d09`, #101 (`serve` inbound iMessage loop) merged at `2ae9740`, and #103
  (deterministic subscription fan-out test) merged at `5e5a28b`.
- Confirmed PR #97 merged with `typecheck and test` green and zero unresolved
  review threads; branch protection was not bypassed.

## Blockers

- Live model and real-channel acceptance remain operator-only; no credentials
  were used.
- Residual non-blocking items: a stale empty gateway token file blocks startup
  until removed manually; ambiguous groups from one sender across distinct
  chats share `group-unknown:<handle>` (never with 1:1). The pump liveness gap
  (#99), the fail-closed group outbox retry (#100), and the missing `serve`
  inbound channel loop (#101) are fixed and no longer residuals.
- The session has exceeded the automatic four-cycle budget under the owner's
  explicit continuation; the override is recorded in state.

## Next actions

1. Land this cycle-5 follow-up (#102) after CI; the checkpoint itself is #98
   (`ab8e4bf`).
2. PR #104 is the open cycle-6 checkpoint; it is not reviewed or merged here.
   Reconcile #102 and #104 before the next cycle.
3. Then evaluate semantic long-term memory (roadmap open item) and the
   remaining iMessage ambiguity boundary.
