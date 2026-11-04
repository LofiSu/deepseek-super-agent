# Development status

> Checkpoint: 2026-11-04 · `main` = `9a0def3`
> Source of truth: `git`, GitHub PRs/checks, and the evidence in
> `docs/PROJECT_AUDIT.md`. Do not trust this file without re-verifying.

## Main

| Field | Value |
|-------|-------|
| Commit | `9a0def3` |
| Last merged PR | #97 mesh async-release cleanup |
| Merged in cycle 5 | #94 live reference run (owner), #95 metrics assertions, #96 gateway token branch tests, #97 mesh async release; all reviewed APPROVE |
| Merged in cycle 4 | #90 thread keys, #91 live-suite test salvage, #92 mesh queue tests; all APPROVE |
| Merged in cycle 3 | #87 gateway token race, #88 iMessage group edges, #89 cycle-3 reconciliation; all APPROVE |
| Open PRs at checkpoint | this cycle-5 checkpoint PR only |
| Required check | `typecheck and test` |
| Offline suite | 443 passed / 53 files (local run on `9a0def3`, live files excluded) |
| Coverage | not re-measured after #95–#97; `d539e25` CI (run `41609138691`) recorded 82.39% lines, 80.93% branches, 90.11% functions |

The offline command used for the local figure is
`CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run` with
`test/{live-demo,live-e2e,live-modules,team-live,demos-real-channels}.test.ts`
excluded. CI runs the full suite with 15 live tests skipped when no provider
credential is present.

## Active workstreams

| Task | Priority | Branch | Owner | State |
|------|----------|--------|-------|-------|
| GATEWAY-TOKEN-TESTS — EEXIST/ELOOP branches | P2 | `agent/gateway-token-tests` | implementer | merged (#96, `ac1fd79`), APPROVE |
| METRICS-ASSERTIONS — offline counter assertions | P2 | `agent/metrics-assertions` | implementer | merged (#95, `f8554cc`), APPROVE |
| MESH-ASYNC-RELEASE — async rejection node release | P2 | `agent/mesh-async-release` | implementer | merged (#97, `9a0def3`), APPROVE |
| SERVE-CHANNEL-LOOP — inbound iMessage loop for `serve` | P1 | `agent/serve-imessage-loop` | implementer | dispatched (cycle 6) |
| OUTBOX-PERMANENT-FAILURE — stop retrying unroutable sends | P2 | `agent/outbox-permanent-failure` | implementer | dispatched (cycle 6) |
| GATEWAY-REVIEW — review #64 surface | P2 | review only | review lead | #76/#81/#82/#84/#85/#87/#90/#95/#96/#97 APPROVE; #77 corrected |
| CYCLE-5-CHECKPOINT — this checkpoint | P1 | `docs/cycle-5-checkpoint` | chief engineer | in review |

## Completed this cycle (Cycle 5)

- Resumed after the cycle-4 checkpoint with the owner's explicit continuation
  past the four-cycle cap (recorded in `.super-agent/state.json`).
- Merged #95: the three live-relaxed counter assertions are now deterministic
  under the offline MockModel and keep the live fallback.
- Merged #96: direct tests for the gateway-token EEXIST winner-reuse path and
  the create-path ELOOP failure; both fail on the base.
- Merged #97: a non-queued Worker turn that rejects asynchronously now returns
  the reserved mesh node and logs `[harness] worker failed ...`, matching the
  synchronous-throw and queued paths.
- Verified `main` `9a0def3` locally: `tsc --noEmit`, `pnpm lint`,
  `pnpm format:check` clean; offline suite 443 passed / 53 files.
- Confirmed PR #97 merged with `typecheck and test` green and zero unresolved
  review threads; branch protection was not bypassed.

## Blockers

- Live model and real-channel acceptance remain operator-only; no credentials
  were used.
- Residual non-blocking items: stale empty gateway token file blocks startup
  until removed manually; fail-closed group tickets still enqueue outbox rows
  that retry to `failed` (now assigned to OUTBOX-PERMANENT-FAILURE);
  ambiguous groups from one sender across distinct chats share
  `group-unknown:<handle>` (never with 1:1); `serve` still lacks an inbound
  channel loop (now assigned to SERVE-CHANNEL-LOOP).
- The session has exceeded the automatic four-cycle budget under the owner's
  explicit continuation; the override is recorded in state.

## Next actions

1. Land this cycle-5 checkpoint after CI.
2. Review the two cycle-6 implementation PRs when they arrive; merge only with
   green `typecheck and test` and no unresolved threads.
3. Cycle 6 checkpoint: update this file, `docs/AGENT_LOG.md`,
   `docs/PR_REVIEW_LOG.md`, `docs/AGENT_REGISTRY.md`, and `.super-agent/state.json`.
4. Then evaluate semantic long-term memory (roadmap open item) and the
   remaining iMessage ambiguity boundary.
