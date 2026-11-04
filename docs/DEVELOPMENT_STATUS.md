# Development status

> Checkpoint: 2026-11-04 · `main` = `2ae9740`
> Source of truth: `git`, GitHub PRs/checks, and the evidence in
> `docs/PROJECT_AUDIT.md`. Do not trust this file without re-verifying.

## Main

| Field | Value |
|-------|-------|
| Commit | `2ae9740` |
| Last merged PR | #101 `serve --imessage` inbound loop |
| Merged in cycle 6 | #99 mesh failure pump (peer session), #100 outbox permanent failure, #101 serve inbound iMessage loop; all reviewed APPROVE |
| Merged in cycle 5 | #94 owner live reference run, #95 metrics assertions, #96 gateway token branch tests, #97 mesh async release, #98 cycle-5 checkpoint |
| Merged in cycle 4 | #90 thread keys, #91 live-suite test salvage, #92 mesh queue tests, #93 cycle-4 checkpoint |
| Open PRs at checkpoint | this cycle-6 checkpoint PR only |
| Required check | `typecheck and test` |
| Offline suite | 452 passed / 54 files (local run on `2ae9740`, live files excluded) |
| Coverage | not re-measured this cycle; #99 post-merge CI (run `41791336153`) recorded 82.42% lines, 81.03% branches, 90.11% functions |

The offline command used for the local figure is
`CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run` with
`test/{live-demo,live-e2e,live-modules,team-live,demos-real-channels}.test.ts`
excluded. CI runs the full suite with 15 live tests skipped when no provider
credential is present.

## Active workstreams

| Task | Priority | Branch | Owner | State |
|------|----------|--------|-------|-------|
| SERVE-CHANNEL-LOOP — inbound iMessage loop for `serve` | P1 | `agent/serve-imessage-loop` | implementer | merged (#101, `2ae9740`), APPROVE after docs correction |
| OUTBOX-PERMANENT-FAILURE — fail unroutable sends immediately | P2 | `agent/outbox-permanent-failure` | implementer | merged (#100, `55f0d09`), APPROVE |
| MESH-FAILURE-PUMP — pump after a failed non-queued Worker | P2 | `agent/mesh-failure-pump` | peer session | merged (#99, `6184a27`), reviewed APPROVE |
| GATEWAY-REVIEW — review #64 surface | P2 | review only | review lead | #76/#81/#82/#84/#85/#87/#90/#95/#96/#97/#99/#100/#101 APPROVE; #77 corrected |
| CYCLE-6-CHECKPOINT — this checkpoint | P1 | `docs/cycle-6-checkpoint` | chief engineer | in review |

## Completed this cycle (Cycle 6)

- Merged #100: `PermanentDeliveryError` lets the outbox mark an unroutable
  group row `failed` on the first flush instead of retrying it to the attempt
  limit; transient failures keep the existing backoff.
- Merged #101: the iMessage polling loop is now shared code
  (`src/cli/channel-loop.ts`); `ds-agent serve --imessage` runs it beside the
  daemon with the same default-deny admission, cursor, and outbox. Admission is
  validated before `Runtime.create` (SQLite) and `chat.db`; SIGINT/SIGTERM
  aborts polling, drains the loop, closes the API, then finishes the runtime.
  Default `serve` is unchanged.
- Reviewed and recorded #99 (merged by a peer session): a failed non-queued
  Worker releases its node and then pumps the queue, so a parked Worker cannot
  wait on an already-free node.
- Verified `main` `2ae9740` locally: `tsc --noEmit`, `pnpm lint` (229 files),
  `pnpm format:check` clean; offline suite 452 passed / 54 files.
- Every merge was based on a reviewed head with green `typecheck and test`;
  branch protection was not bypassed.

## Blockers

- Live model and real-channel acceptance remain operator-only; no credentials
  were used. `serve --imessage` needs macOS Full Disk Access and Automation
  permission before its first live pull.
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

1. Land this cycle-6 checkpoint after CI.
2. Evaluate semantic long-term memory (roadmap open item) or draft the
   stale-gateway-token ADR, whichever the owner prioritises.
3. Consider a Feishu inbound loop for `serve` using the shared channel-loop seam.
4. Keep `.super-agent/state.json` truthful at every checkpoint.
