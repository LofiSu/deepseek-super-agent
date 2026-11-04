# Development status

> Checkpoint: 2026-11-04 · baseline `main` = `55f3e7b` (cycle-6 checkpoint)
> Source of truth: `git`, GitHub PRs/checks, and the evidence in
> `docs/PROJECT_AUDIT.md`. Do not trust this file without re-verifying; later
> merges after this baseline are not reflected.

## Main

| Field | Value |
|-------|-------|
| Commit | `55f3e7b` |
| Last merged PR | #102 `CYCLE-5-CHECKPOINT` follow-up (docs: ADR-008, audit evidence, corrections) |
| Merged in cycle 6 | #99 MESH-FAILURE-PUMP (`6184a27`), #100 OUTBOX-PERMANENT-FAILURE (`55f0d09`), #101 SERVE-CHANNEL-LOOP (`2ae9740`), #103 SUBSCRIPTION-FANOUT-TEST (`5e5a28b`, test-only), #102 cycle-5 docs follow-up (`55f3e7b`) |
| Merged in cycle 5 | #94 live reference run (owner), #95 metrics assertions, #96 gateway token branch tests, #97 mesh async release, #98 cycle-5 checkpoint |
| Merged in cycle 4 | #90 thread keys, #91 live-suite test salvage, #92 mesh queue tests, #93 cycle-4 checkpoint |
| Open PRs at checkpoint | this cycle-6 checkpoint PR only |
| Required check | `typecheck and test` |
| CI at `5e5a28b` | 464 passed / 15 skipped (479 tests), 59 files: 56 passed, 3 fully skipped |
| Full live suite at `5e5a28b` (peer run) | 476 passed / 3 skipped (479 tests), 58 files passed, exit 0, 567.76s |
| Coverage at `5e5a28b` | 82.82% statements/lines (7993/9651), 81.09% branches (2878/3549), 90.96% functions (705/775); coverage run 463 passed, 55 files |
| Local cycle-6 gate | `tsc --noEmit` clean, `pnpm lint` ok (229 tracked files), `pnpm format:check` clean, offline 452 passed / 54 files |

The CI figures are the post-merge `main` run at `5e5a28b` (run `41792700396`,
`typecheck and test` job `126449544790`). The full live suite was run by peer
session sulin-5f on `5e5a28b` (`DS_AGENT_API_MODEL=auto/deepseek-v4.1-flash`):
476 passed / 3 skipped, 58 files passed, exit 0, 567.76s; its log is
`/tmp/ds-agent-live-e2e-logs/full-2026-11-04.log`. It is a live-model run, not
real-channel acceptance. The local offline command is
`CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run` with
`test/{live-demo,live-e2e,live-modules,team-live,demos-real-channels}.test.ts`
excluded. CI runs the full suite with the 15 live tests skipped when no provider
credential is present. #102 (`55f3e7b`) is docs-only and did not change the
suite.

## Active workstreams

| Task | Priority | Branch | Owner | State |
|------|----------|--------|-------|-------|
| SERVE-CHANNEL-LOOP — inbound iMessage loop for `serve` | P1 | `agent/serve-imessage-loop` | implementer | merged (#101, `2ae9740`), APPROVE after docs correction |
| OUTBOX-PERMANENT-FAILURE — fail unroutable sends immediately | P2 | `agent/outbox-permanent-failure` | implementer | merged (#100, `55f0d09`), APPROVE |
| MESH-FAILURE-PUMP — pump after a failed non-queued Worker | P2 | `agent/mesh-failure-pump` | peer session | merged (#99, `6184a27`), reviewed APPROVE |
| SUBSCRIPTION-FANOUT-TEST — deterministic many-to-many workers | P2 | `debug/subscription-timeout` | peer session | merged (#103, `5e5a28b`), reviewed APPROVE (test-only) |
| CYCLE-5-CHECKPOINT follow-up — ADR-008 and audit evidence | P2 | `docs/cycle-5-checkpoint-followup` | peer session | merged (#102, `55f3e7b`), docs APPROVE |
| GATEWAY-REVIEW — review #64 surface | P2 | review only | review lead | #76/#81/#82/#84/#85/#87/#90/#95/#96/#97/#99/#100/#101/#103 APPROVE; #77 corrected |
| CYCLE-6-CHECKPOINT — this checkpoint | P1 | `docs/cycle-6-checkpoint` | chief engineer | in review (#104) |

## Completed this cycle (Cycle 6)

- Merged #99: a failed non-queued Worker now releases its node and then pumps
  the queue, so an already-parked Worker cannot wait on a free node.
- Merged #100: `PermanentDeliveryError` lets the outbox mark an unroutable
  group row `failed` on the first flush instead of retrying to the attempt
  limit; transient failures keep the existing backoff.
- Merged #101: the iMessage polling loop is now shared code
  (`src/cli/channel-loop.ts`); `ds-agent serve --imessage` runs it beside the
  daemon with the same default-deny admission, cursor, and outbox. Admission is
  validated before `Runtime.create` (SQLite) and `chat.db`; SIGINT/SIGTERM
  aborts polling, drains the loop, closes the API, then finishes the runtime.
  Default `serve` is unchanged.
- Merged #103 (peer session, test-only): the many-to-many subscription test now
  scripts its incidental Worker turns, removing live-model latency without
  weakening the fan-out assertion.
- Merged #102 (peer session, docs): ADR-008 for #97, the cycle-5 CI figures in
  `docs/PROJECT_AUDIT.md`, and corrections to the #96 non-vacuity statement and
  #97 file counts.
- Verified `main` `55f3e7b` locally: `tsc --noEmit`, `pnpm lint` (229 files),
  `pnpm format:check` clean; offline suite 452 passed / 54 files on `5e5a28b`.
- Every merge was based on a reviewed head with green `typecheck and test`;
  branch protection was not bypassed.

## Blockers

- This session used no model credentials and performed no real-channel run; the
  full live-model suite was run by peer session sulin-5f on `5e5a28b` (see
  above). Real-channel acceptance remains operator-only. `serve --imessage`
  needs macOS Full Disk Access and Automation permission before its first live
  pull.
- Residual non-blocking items:
  - An in-flight `chat.db` pull cannot be cancelled (`ImessageApi` has no signal);
    shutdown waits for it, and a hung read needs the second-signal force exit.
  - Ingest failures are logged and skipped and the cursor still advances, so that
    trigger is not replayed (same as `ds-agent imessage`).
  - `serve --imessage` retries schema errors forever with capped backoff by
    design; it does not start the embedded gateway.
  - `PermanentDeliveryError` detection is `instanceof`-based (safe for in-process
    adapters); a terminal permanent failure leaves the reply `pending`, matching
    the existing attempt-limit path.
  - Stale empty gateway token file still blocks startup until removed manually
    (needs an ADR).
  - Ambiguous groups from one sender across distinct chats still share
    `group-unknown:<handle>` (never with 1:1).
- The session has exceeded the automatic four-cycle budget under the owner's
  explicit continuation; the override is recorded in state.

## Next actions

1. Land this cycle-6 checkpoint (#104) after CI.
2. Evaluate semantic long-term memory (roadmap open item) or draft the
   stale-gateway-token ADR, whichever the owner prioritises.
3. Consider a Feishu inbound loop for `serve` using the shared channel-loop seam.
4. Keep `.super-agent/state.json` truthful at every checkpoint.
