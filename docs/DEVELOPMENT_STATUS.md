# Development status

> Checkpoint: 2026-11-04 · baseline `main` = `064ab06` (cycle-8 checkpoint)
> Source of truth: `git`, GitHub PRs/checks, and the evidence in
> `docs/PROJECT_AUDIT.md`. Do not trust this file without re-verifying; later
> merges after this baseline are not reflected.

## Main

| Field | Value |
|-------|-------|
| Commit | `064ab06` |
| Last merged PR | #109 STALE-GATEWAY-TOKEN-FOLLOWUP (ADR-009 implementation) |
| Merged in cycle 8 | #109 STALE-GATEWAY-TOKEN-FOLLOWUP (`064ab06`) |
| Merged in cycle 7 | #106 FEISHU-SERVE-LOOP (`e9a1978`), #105 STALE-GATEWAY-TOKEN ADR-009 (`69b6d3d`, docs-only), #107 IMESSAGE-GROUP-UNKNOWN (`00665d2`) |
| Merged in cycle 6 | #99 MESH-FAILURE-PUMP (`6184a27`), #100 OUTBOX-PERMANENT-FAILURE (`55f0d09`), #101 SERVE-CHANNEL-LOOP (`2ae9740`), #103 SUBSCRIPTION-FANOUT-TEST (`5e5a28b`), #102 cycle-5 docs follow-up (`55f3e7b`) |
| Merged in cycle 5 | #94 live reference run (owner), #95 metrics assertions, #96 gateway token branch tests, #97 mesh async release, #98 cycle-5 checkpoint |
| Merged in cycle 4 | #90 thread keys, #91 live-suite test salvage, #92 mesh queue tests, #93 cycle-4 checkpoint |
| Open PRs at checkpoint | this cycle-8 checkpoint PR only |
| Required check | `typecheck and test` |
| CI at `064ab06` | 489 passed / 15 skipped (504 tests), 60 files: 57 passed, 3 fully skipped |
| Coverage at `064ab06` | 82.80% statements/lines (8168/9864), 81.56% branches (2968/3639), 90.98% functions (717/788); coverage run 488 passed, 56 files |
| Local cycle-8 gate | `tsc --noEmit` clean, `pnpm lint` ok (231 tracked files), `pnpm format:check` clean, offline 477 passed / 55 files |

The CI figures are the post-merge `main` run at `064ab06` (run `41797671287`,
`typecheck and test`). The local offline command is
`CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run` with
`test/{live-demo,live-e2e,live-modules,team-live,demos-real-channels}.test.ts`
excluded. CI runs the full suite with the 15 live tests skipped when no provider
credential is present. The last full live suite available at this checkpoint was
run by peer session sulin-5f on `5e5a28b` (476 passed / 3 skipped, exit 0); no
live suite was run on `064ab06`.

## Active workstreams

| Task | Priority | Branch | Owner | State |
|------|----------|--------|-------|-------|
| STALE-GATEWAY-TOKEN — ADR-009 policy and implementation | P1 | `agent/stale-gateway-token-adr`, `agent/stale-gateway-token-followup` | implementer | merged (#105 docs `69b6d3d`, #109 code `064ab06`), APPROVE |
| GATEWAY-REVIEW — review #64 surface | P2 | review only | review lead | #76/#81/#82/#84/#85/#87/#90/#95/#96/#97/#99/#100/#101/#103/#105/#106/#107/#109 APPROVE; #77 corrected |
| CYCLE-8-CHECKPOINT — this checkpoint | P1 | `docs/cycle-8-checkpoint` | chief engineer | in review |

## Completed this cycle (Cycle 8)

- Merged #109: `readTokenFile` now throws `GatewayTokenEmptyFileError` (an
  internal subclass of `GatewayTokenFileError`) for a present-but-empty file,
  with a diagnostic that names the zero-length/whitespace cause and tells the
  operator to remove the file. The concurrent-create race keeps its distinct
  `was created concurrently and is empty` message, so a real race is not
  reported as staleness. `readGatewayToken` fails closed for a present empty
  file; an absent file still falls back to minting, and an explicit
  `DS_AGENT_GATEWAY_TOKEN` or CLI override still wins. `ensurePrivateMode`
  still tightens a loose mode to 0600 before the error, as ADR-009 records.
- Updated the ADR-009 status and `docs/GATEWAY.md` to describe the implemented
  behavior; no startup auto-recovery was added (removal stays operator-only).
- Verified `main` `064ab06` locally: `tsc --noEmit`, `pnpm lint` (231 files),
  `pnpm format:check` clean; offline suite 477 passed / 55 files. Targeted
  token tests 45/45 across `test/gateway-token.test.ts`,
  `test/gateway.test.ts`, and `test/cli-gateway.test.ts`.
- Every merge was based on a reviewed head with green `typecheck and test`;
  branch protection was not bypassed.

## Blockers

- This session used no model credentials and performed no Feishu network call;
  live Feishu acceptance remains operator-only. `serve --imessage` still needs
  macOS Full Disk Access/Automation before its first live pull.
- Residual non-blocking items:
  - A present-but-empty `gateway.token` still blocks startup until an operator
    removes it, by ADR-009 design; the error now says why and the client no
    longer silently falls back.
  - An in-flight `chat.db` or Feishu pull cannot be cancelled (no signal in the
    APIs); shutdown waits for it, and a hung read needs the force exit.
  - `serve --imessage` retries schema errors forever with capped backoff by
    design; the Feishu loop logs and skips stream/ingest errors.
  - `group-rowid:<rowid>` is per-database; a `VACUUM`/restore/different machine
    can change it, and upgrading splits old `group-unknown` threads.
  - `PermanentDeliveryError` detection is `instanceof`-based; a terminal
    permanent failure leaves the reply `pending`.
  - Ambiguous groups with no positive chat row still share
    `group-unknown:<handle>` (never with 1:1).
- The session has exceeded the automatic four-cycle budget under the owner's
  explicit continuation; the override is recorded in state.

## Next actions

1. Land this cycle-8 checkpoint after CI.
2. Evaluate semantic/multi-hop long-term memory recall (SEMANTIC-LTM).
3. Draft the optional `--rotate-token` operator flag only if the owner asks.
4. Keep `.super-agent/state.json` truthful at every checkpoint.
