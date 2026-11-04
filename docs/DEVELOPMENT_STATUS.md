# Development status

> Checkpoint: 2026-11-04 · baseline `main` = `00665d2` (cycle-7 checkpoint)
> Source of truth: `git`, GitHub PRs/checks, and the evidence in
> `docs/PROJECT_AUDIT.md`. Do not trust this file without re-verifying; later
> merges after this baseline are not reflected.

## Main

| Field | Value |
|-------|-------|
| Commit | `00665d2` |
| Last merged PR | #107 IMESSAGE-GROUP-UNKNOWN (chat.ROWID thread-key fallback) |
| Merged in cycle 7 | #106 FEISHU-SERVE-LOOP (`e9a1978`), #105 STALE-GATEWAY-TOKEN ADR-009 (`69b6d3d`, docs-only), #107 IMESSAGE-GROUP-UNKNOWN (`00665d2`) |
| Merged in cycle 6 | #99 MESH-FAILURE-PUMP (`6184a27`), #100 OUTBOX-PERMANENT-FAILURE (`55f0d09`), #101 SERVE-CHANNEL-LOOP (`2ae9740`), #103 SUBSCRIPTION-FANOUT-TEST (`5e5a28b`), #102 cycle-5 docs follow-up (`55f3e7b`) |
| Merged in cycle 5 | #94 live reference run (owner), #95 metrics assertions, #96 gateway token branch tests, #97 mesh async release, #98 cycle-5 checkpoint |
| Merged in cycle 4 | #90 thread keys, #91 live-suite test salvage, #92 mesh queue tests, #93 cycle-4 checkpoint |
| Open PRs at checkpoint | this cycle-7 checkpoint PR only |
| Required check | `typecheck and test` |
| CI at `00665d2` | 482 passed / 15 skipped (497 tests), 60 files: 57 passed, 3 fully skipped |
| Coverage at `00665d2` | 82.81% statements/lines (8156/9849), 81.37% branches (2958/3635), 90.97% functions (716/787); coverage run 481 passed, 56 files |
| Local cycle-7 gate | `tsc --noEmit` clean, `pnpm lint` ok (231 tracked files), `pnpm format:check` clean, offline 470 passed / 55 files |

The CI figures are the post-merge `main` run at `00665d2` (run `41795979512`,
`typecheck and test`). The local offline command is
`CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run` with
`test/{live-demo,live-e2e,live-modules,team-live,demos-real-channels}.test.ts`
excluded. CI runs the full suite with the 15 live tests skipped when no provider
credential is present. The last full live suite in this session was the
peer-run run on `5e5a28b` (476 passed / 3 skipped, exit 0); no live suite was
run on `00665d2`.

## Active workstreams

| Task | Priority | Branch | Owner | State |
|------|----------|--------|-------|-------|
| FEISHU-SERVE-LOOP — opt-in inbound Feishu loop for `serve` | P2 | `agent/feishu-serve-loop` | implementer | merged (#106, `e9a1978`), APPROVE |
| STALE-GATEWAY-TOKEN — ADR-009 for empty token recovery | P1 | `agent/stale-gateway-token-adr` | implementer | merged (#105, `69b6d3d`), docs APPROVE after correction; implementation follow-up open |
| IMESSAGE-GROUP-UNKNOWN — chat.ROWID thread-key fallback | P2 | `agent/imessage-group-unknown` | peer session | merged (#107, `00665d2`), reviewed APPROVE |
| GATEWAY-REVIEW — review #64 surface | P2 | review only | review lead | #76/#81/#82/#84/#85/#87/#90/#95/#96/#97/#99/#100/#101/#103/#105/#106/#107 APPROVE; #77 corrected |
| CYCLE-7-CHECKPOINT — this checkpoint | P1 | `docs/cycle-7-checkpoint` | chief engineer | in review |

## Completed this cycle (Cycle 7)

- Merged #106: `ds-agent serve --feishu` runs an inbound Feishu poll loop
  beside the daemon. Config is validated before `Runtime.create`; the durable
  cursor is `feishu_cursor/cursor = { chatId, lastCreateTimeMs }` with
  precedence `--since` > stored-for-chat > FeishuSource's now-5min; pulls that
  fail retry with bounded backoff; SIGINT/SIGTERM aborts, drains, then runs
  `Runtime.finish()`. `--imessage` and `--feishu` cannot be combined; default
  `serve` is unchanged.
- Merged #105: ADR-009 keeps a stale empty `gateway.token` fail-closed and
  requires explicit operator recovery; it rejects automatic regeneration,
  rename-aside, and treating empty as missing, and documents the current
  misleading error and the client's silent fallback. Docs-only; the code
  follow-up is not done.
- Merged #107: legacy group chats with no guid or identifier now key on
  `chat.ROWID` (`group-rowid:<rowid>`) instead of collapsing into
  `group-unknown:<handle>`. Precedence stays guid > identifier > rowid >
  fallback; ROWID is taken only from a positive group row, 1:1 stays
  `handle:<handle>`, and outbound still fails closed without a guid/identifier.
  Existing `group-unknown` threads split on upgrade (documented).
- Verified `main` `00665d2` locally: `tsc --noEmit`, `pnpm lint` (231 files),
  `pnpm format:check` clean; offline suite 470 passed / 55 files.
- Every merge was based on a reviewed head with green `typecheck and test`;
  branch protection was not bypassed.

## Blockers

- This session used no model credentials and performed no Feishu network call;
  live Feishu acceptance remains operator-only. `serve --imessage` still needs
  macOS Full Disk Access/Automation before its first live pull.
- Residual non-blocking items:
  - ADR-009 is not implemented: the startup error still says "created
    concurrently" for a stale file, and the client read path still falls back
    silently instead of failing closed.
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

1. Land this cycle-7 checkpoint after CI.
2. Implement ADR-009's diagnostics and client fail-closed behavior
   (`src/gateway/token.ts` + tests).
3. Evaluate semantic long-term memory, or draft the `--rotate-token` operator
   flag, whichever the owner prioritises.
4. Keep `.super-agent/state.json` truthful at every checkpoint.
