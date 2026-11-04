# Development status

> Checkpoint: 2026-11-04 · baseline `main` = `661e56d` (final integration cycle)
> Source of truth: `git`, GitHub PRs/checks, and the evidence in
> `docs/PROJECT_AUDIT.md`. Do not trust this file without re-verifying; later
> merges after this baseline are not reflected. The cycle-9 tables below are
> retained as history, not as the current state.

## Final integration checkpoint (2026-11-04)

The owner-directed program is integrated on `main`: semantic long-term memory,
read isolation, store migrations, A2A with peer auth, model slow path, cross-host
mesh registry/inbox, local UI, backup/restore and release checks, and combined
Feishu/iMessage serving. The remaining items are owner-gated or evidence-bound,
not missing implementation.

| Field | Value |
|-------|-------|
| `main` at this checkpoint | `661e56d` (PR #140 merge; includes #132 `a1985c0`, #134 `111481d`, #139 `af6b011`, #140 `661e56d`) |
| Merged in this program | #123 A2A HTTP auth (`7a1d732`), #124 lifecycle schema v3 (`888f810`), #126 threat model (`6db42b7`), #127 health/observability (`e700730`), #128 model slow path (`788be60`), #130 remote mesh (`d9ded0b`), #131 backup/release checks (`d67731a`), #133 combined channels (`0cdea17`), #129 local UI (`123ee40`), #136 CLI wiring (`1e01862`), #135 channel slow path (`268809d`), #138 usage accuracy (`58c410a`) |
| Merged outside this session's orchestration | #132 release workflow (`a1985c0`) merged by another session without recorded owner approval; #134 iMessage nanosecond dates (`111481d`), #139 iMessage non-ASCII argv (`af6b011`), and #140 iMessage canned-ack suppression (`661e56d`) merged by other sessions without review in this log. All four had green `typecheck and test` on their exact heads. |
| Owner-gated deviation | #132 was held as owner-gated by this session; it is on `main` anyway. Post-merge audit of its content: `workflow_dispatch` only, `permissions: contents: read`, no `secrets.*`, no publish step, artifact upload only. This is recorded as a process deviation, not as owner approval. |
| Required check | `typecheck and test` (strict, admins enforced, conversation resolution required) |
| Main CI | green after each merge (post-merge `main` runs `41848077717` at `661e56d`, `41847695711` at `af6b011`); #140 head `69a243c` green, #139 head `50cf9d1` green, #134 head `56cb001` green, #132 head `21cc421` green, #138 head `33b0941` run `41845978818`, #135 head `096e83c` run `41845266705`, #136 head `740c61c` run `41844155920`, #129 head `ab73604` run `41829844125` |
| Local offline gate on #135 merged head | `tsc --noEmit` clean; `pnpm lint` ok (268 files); CI-equivalent full suite 75 files / 724 tests: 709 passed, 15 skipped, 0 failed |
| UI gate | `test/cli-ui.test.ts` 12/12; `test/cli-command-wiring.test.ts` 4/4; CI `typecheck and test` green on `ab73604` (run `41829844125`). A separate bare local full-suite run on `ab73604` had 3 long `test/subscription.test.ts` failures under concurrent load; that file passes 19/19 when run alone, and CI's CI-env full run passed. |
| Open high-risk PRs | none; #141 is documentation-only. The #132 owner gate was bypassed by another session (see above). |

### Task status

- **Complete:** M0–M10 core, M11 CLI/demo, T01–T16, T18–T46, T49 (local UI),
  T50 (A2A plus authenticated HTTP transport), T51 (credential boundaries).
- **Wired end-to-end:** model slow path (`DS_AGENT_SLOW_PATH=model`) reaches
  iMessage/Feishu via `Runtime.ingestAsync`; `ds-agent ui`, `backup`, `restore`
  are registered; `serve --imessage --feishu` runs both loops over one Runtime.
- **Partial by design:** T47 remote mesh has registry/heartbeat/dispatch and an
  authenticated handler, but no default Runtime listener; T48 is lexically
  strong (retention, dedupe, tag hop) but has no embedding recall and no
  month-scale measurement.
- **External/operator:** live bake-off measurement, real Feishu credentials,
  remote mesh exposure, release publishing, and any production infrastructure.

### Known gaps and honest limits

- No live bake-off was run in this program; offline fixtures and CI only.
- Feishu credentials are absent in this environment; iMessage is configured on
  the old daemon but no live send was performed in this session.
- The local UI is single-user loopback with a shared token; there are no
  accounts, TLS, or remote access.
- A2A/mesh exposure requires unique per-peer secrets, TLS off loopback, and an
  operator-mounted listener; the replay cache is process-local.
- The semantic LTM path is lexical plus one tag hop; embeddings remain a port
  boundary with a deterministic mock only.
- Process deviation: #132 (release workflow) was owner-gated and merged by a
  different session at `a1985c0` without recorded owner approval. The workflow
  is manual, read-only, and publishes nothing, but the gate was not honored.

## Historical cycle-9 checkpoint

## Main

| Field | Value |
|-------|-------|
| Commit | `f6e5972` |
| Last merged PR | #112 SEMANTIC-LTM (ADR-010 + offline recall evaluation) |
| Merged in cycle 9 | #111 README-REFRESH by a peer session (`648eec9`), #112 SEMANTIC-LTM (`f6e5972`) |
| Merged in cycle 8 | #109 STALE-GATEWAY-TOKEN-FOLLOWUP (`064ab06`), #110 cycle-8 checkpoint (`5141e29`) |
| Merged in cycle 7 | #106 FEISHU-SERVE-LOOP (`e9a1978`), #105 STALE-GATEWAY-TOKEN ADR-009 (`69b6d3d`, docs-only), #107 IMESSAGE-GROUP-UNKNOWN (`00665d2`), #108 cycle-7 checkpoint (`6e19bca`) |
| Merged in cycle 6 | #99 MESH-FAILURE-PUMP (`6184a27`), #100 OUTBOX-PERMANENT-FAILURE (`55f0d09`), #101 SERVE-CHANNEL-LOOP (`2ae9740`), #103 SUBSCRIPTION-FANOUT-TEST (`5e5a28b`), #102 cycle-5 docs follow-up (`55f3e7b`) |
| Open PRs at checkpoint | this cycle-9 checkpoint PR only |
| Required check | `typecheck and test` |
| CI at `f6e5972` | 493 passed / 15 skipped (508 tests), 61 files: 58 passed, 3 fully skipped |
| Coverage at `f6e5972` | 82.80% statements/lines (8168/9864), 81.54% branches (2969/3641), 90.98% functions (717/788); coverage run 492 passed, 57 files |
| Local cycle-9 gate | `tsc --noEmit` clean, `pnpm lint` ok (232 tracked files), `pnpm format:check` clean, offline 481 passed / 56 files |

The CI figures are the post-merge `main` run at `f6e5972` (run `41800320615`,
`typecheck and test`). The local offline command is
`CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run` with
`test/{live-demo,live-e2e,live-modules,team-live,demos-real-channels}.test.ts`
excluded. CI runs the full suite with the 15 live tests skipped when no provider
credential is present. The last full live suite available at this checkpoint was
run by peer session sulin-5f on `5e5a28b` (476 passed / 3 skipped, exit 0); no
live suite was run on `f6e5972`.

## Active workstreams

| Task | Priority | Branch | Owner | State |
|------|----------|--------|-------|-------|
| SEMANTIC-LTM — evaluate semantic/multi-hop long-term memory recall | P2 | `agent/semantic-ltm-evaluation` | implementer | merged (#112, `f6e5972`), APPROVE; ADR-010 follow-up open |
| GATEWAY-REVIEW — review #64 surface | P2 | review only | review lead | #76/#81/#82/#84/#85/#87/#90/#95/#96/#97/#99/#100/#101/#103/#105/#106/#107/#109/#112 APPROVE; #77 corrected |
| CYCLE-9-CHECKPOINT — this checkpoint | P1 | `docs/cycle-9-checkpoint` | chief engineer | in review |

## Completed this cycle (Cycle 9)

- Merged #112: ADR-010 fixes an offline, deterministic evaluation of long-term
  memory recall and measures the current `query()` at macro recall@3 4/11
  (0.364): exact 2/2, word order 2/2, paraphrase 0/3, tag-only 0/2, multi-hop
  0/2, with both negative controls empty. Normalization plus an in-repo
  synonym/morphology map reaches 7/11 (0.636); adding tag-only retrieval and
  one-hop tag expansion reaches 11/11 (1.000). A deterministic mock embedding
  and a hybrid ranker also reach 11/11 but add zero recall over the
  lexical+hop option, so embeddings remain unimplemented behind a documented
  `EmbeddingPort` boundary. No product source changed; the evaluation is a
  new test file and docs.
- Merged #111 (peer session): README refresh documenting serve inbound loops,
  gateway fail-closed recovery, and current live-run evidence. Docs-only; it
  moved the baseline to `648eec9` while #112 was in review.
- Verified `main` `f6e5972` locally: `tsc --noEmit`, `pnpm lint` (232 files),
  `pnpm format:check` clean; offline suite 481 passed / 56 files. Independent
  memory test run on the reviewed head: 20 passed / 2 files.
- Every merge was based on a reviewed head with green `typecheck and test`;
  branch protection was not bypassed.

## Blockers

- This session used no model credentials and performed no Feishu network call;
  live Feishu acceptance remains operator-only. `serve --imessage` still needs
  macOS Full Disk Access/Automation before its first live pull.
- Residual non-blocking items:
  - M6 recall remains lexical in production. ADR-010 chose normalization plus
    tag-only retrieval and one-hop tag expansion, but that follow-up is not
    implemented; the evaluation corpus is synthetic and small, and month-scale
    is argued from the retention cap rather than benchmarked.
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

1. Land this cycle-9 checkpoint after CI.
2. Implement ADR-010's lexical normalization + tag-only retrieval + one-hop tag
   expansion, with at least 10 held-out queries and a 1000-entry fixture.
3. Draft the optional `--rotate-token` operator flag only if the owner asks.
4. Keep `.super-agent/state.json` truthful at every checkpoint.
