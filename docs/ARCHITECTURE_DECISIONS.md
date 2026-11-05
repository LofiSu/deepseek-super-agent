# Architecture decisions

Record decisions that change or clarify a boundary. Do not use this file to
rewrite `PLAN.md`; link to the contract instead.

## ADR-001 — iMessage admission fails closed

- **Date:** 2026-11-03
- **Status:** accepted; #77 merged the gate, #81 merged the group correction
- **Context:** `#64` marked every iMessage trigger `addressed: 'direct'`. The
  ingress `admissionDeny` already runs before `addressed`, but a default run
  configures no admission rules, so nothing is denied and the always-`direct`
  marker passes the fast path. `--handle`/`DS_AGENT_IMESSAGE_HANDLE` was
  optional, and no group metadata was read. Any sender in any chat could
  trigger work. A message joined to multiple chats can be deduped to a 1:1 row.
- **Decision:** require a sender allowlist (`--handle`,
  `DS_AGENT_IMESSAGE_HANDLE`, or non-empty `DS_AGENT_ACTOR_ALLOWLIST`) unless
  the operator passes an explicit `--allow-any` opt-out. Group chats are closed
  by default and require an explicit `--allow-groups`. Groupness is aggregated
  across all `chat_message_join` rows before guid dedupe; missing or ambiguous
  chat metadata is treated as group/unknown. A group message is never
  `addressed: 'direct'` and carries `channel.address.group` when allowed.
- **Consequences:** default open use now fails with a clear error. Operators who
  need any-sender behavior must opt in and see a warning. The handle is trimmed
  once and used for both the gate and the SQL filter. Tests cover the refusal,
  the 1:1 path, multi-chat group detection, missing metadata, and group
  filtering.
- **Alternatives rejected:** relying on the existing ingress actor allowlist
  (optional and not enforced by the channel); content-based mention detection
  (untrusted and brittle); treating group chats as direct (unsafe); selecting
  the first joined chat row (order-dependent and unsafe).

## ADR-002 — Mesh backpressure is process-local and Harness-owned

- **Date:** 2026-11-03
- **Status:** accepted; #79 merged, corrected by #84
- **Context:** `WorkerMeshRegistry` reports capacity, but `Harness.launch`
  ignored `undefined` and ran the Worker anyway. Capacity was advisory.
- **Decision:** keep the registry as pure accounting. Add a bounded FIFO pending
  queue to the Harness. A Worker starts only after `pickNode` succeeds. Pump the
  queue on ticket release. Route `Assignment.node` placement through
  `Engine.assignmentPlaced`; the Harness must not write the ticket aggregate.
  Release the slot and pump only after the terminal ticket state is committed,
  and re-validate the queued ticket immediately before start. The queue is
  explicitly process-local; restart recovery is a separate concern (ADR-004)
  and does not claim persistence.
- **Consequences:** no Worker runs above configured capacity. A full queue
  rejects the launch without throwing; the ticket remains open for retry/drain.
  Drain clears the queue and resolves waiters instead of hanging; ordinary
  settle waits for queued work rather than dropping it. The Harness has no
  direct ticket write.
- **Alternatives rejected:** blocking the event loop until a slot frees
  (unbounded latency); rejecting at the Engine (domain writer must not own
  scheduling); persisting the queue in SQLite in this task (mixes scheduling
  with domain state and belongs with restart recovery).

## ADR-003 — Gateway is infrastructure, not a domain actor

- **Date:** 2026-11-03
- **Status:** accepted
- **Context:** the local gateway proxies model calls and exposes usage/metrics.
  It sits next to the Harness/Engine but must not acquire domain rules.
- **Decision:** the gateway may authenticate local clients, route providers,
  mask payloads, meter usage, and expose read-only health/metrics. It must not
  create tickets, decide evals, or write replies. Its credential handling follows
  the same redaction rules as the runtime.
- **Consequences:** gateway changes require security review but not domain
  contract changes. `/health` and the dashboard stay unauthenticated only on a
  loopback bind; non-loopback binds must warn.

## ADR-004 — Restart recovery is at-least-once

- **Date:** 2026-11-03
- **Status:** accepted; implemented by #85 (`10e9f3c`)
- **Context:** a killed process leaves a running assignment and a session
  journal. Replaying the exact turn is not possible, and external side effects
  may already have occurred.
- **Decision:** on startup, end the interrupted assignment through the Engine,
  create exactly one replacement assignment, append a `RECOVERED` prompt, and
  relaunch only with a live model and an unpaused ticket. Run the scan once per
  `Runtime`; a real restart constructs a new one. A crash after the transaction
  but before launch is repaired by relaunching the existing pending replacement
  without creating another assignment or prompt. Document at-least-once
  semantics; do not claim exactly-once.
- **Consequences:** no ticket stays permanently `running` after a restart.
  Recovery is idempotent in-process and across restarts. A MockModel start logs
  `[recovery] deferred reason=mock-model` and does not mutate or consume the
  interrupted state. Launch failures are logged and isolated per ticket.
- **Alternatives rejected:** silently re-running the journal (duplicates side
  effects without a record); leaving the watchdog to clean up (can take a full
  stale window and fails permanently if no daemon runs).

## ADR-005 — Project orchestration has a single owner

- **Date:** 2026-11-03
- **Status:** accepted (`#78`)
- **Context:** multiple sessions and subagents can act on the same repository.
  Concurrent merges and duplicated dispatches previously moved `main` while a
  review was running and left stale PR bases.
- **Decision:** the main session is the only owner of the project-level
  orchestration loop. It alone writes `.super-agent/state.json`, the master
  plan, and the cycle log, and it controls merges. Subagents own one task, work
  in isolated worktrees, write tests, open PRs, and never merge or edit project
  state. Start with at most 3 implementation agents and at most 4 completed
  cycles per session while the pipeline is validated.
- **Consequences:** `next_action` and `mode` are explicit state fields, so a
  resumed session can tell planning from execution, review, integration, and
  checkpoint. A fourth cycle boundary pauses the session and requires a
  recovery report instead of spawning more agents.
- **Alternatives rejected:** a per-agent scheduler (duplicate loops and races);
  allowing implementers to merge their own work (no independent gate); unlimited
  concurrency (unbounded cost and conflicting writes).

## ADR-006 — iMessage conversation keys are namespaced by conversation shape

- **Date:** 2026-11-03
- **Status:** accepted; implemented by #90
- **Context:** `imessageThreadFor` fell back to `handle:<sender>` whenever a
  message had no chat guid. An ambiguous group message therefore shared a
  thread — and therefore ticket context — with a 1:1 message from the same
  sender. #88 fixed the outbound address but not the thread identity.
- **Decision:** a chat guid always wins (`chat:<guid>`). Without one, a group
  message yields `group:<chatIdentifier>` when a positive identifier exists and
  `group-unknown:<handle>` otherwise; a 1:1 message yields `handle:<handle>`.
  Group and 1:1 keys are disjoint by prefix. The group flag comes from the
  resolved `isGroupMessage` result, not from raw caller metadata. Positive-group
  guids and identifiers aggregate independently so an identifier-only row
  cannot hide a later guid.
- **Consequences:** group content cannot enter a 1:1 ticket's context. Existing
  group threads keyed under the old `handle:` key do not correlate after the
  upgrade; this is a one-time context split, not a data migration. An ambiguous
  group from one sender across distinct group chats still shares one key; it
  never shares with 1:1.
- **Alternatives rejected:** keeping the handle fallback (context mixing);
  keying each ambiguous message by its own guid (fragments every turn into a new
  thread); treating the first joined chat's identifier as the group (unsafe,
  order-dependent).

## ADR-007 — Deliberate MockModel tests opt in per call

- **Date:** 2026-11-03
- **Status:** accepted; implemented by #91
- **Context:** the credential-sentinel test injects a capturing MockModel and
  therefore needs to run under the live `pnpm test` default without a provider
  key. The global `DS_AGENT_ALLOW_MOCK_FIXTURE=1` flag was the only opt-in and
  weakened the fixture guard for every test in the process.
- **Decision:** `freshRuntime` accepts an explicit `allowMockModel: true` option.
  The default remains a refusal: a MockModel is rejected unless the caller opts
  in or the environment flag is set. The option is stripped before
  `Runtime.create`, and only the credential sentinel uses it.
- **Consequences:** the sentinel is deterministic under the live suite without
  changing the default guard. A new test that intends to use MockModel must say
  so at the call site. The offline CI path continues to use the environment
  flag.
- **Alternatives rejected:** enabling MockModel by default (removes the safety
  guard); a second fixture factory (duplicates runtime setup); skipping the
  sentinel under a live run (loses the credential-leak check).

## ADR-008 — Worker start failure releases the reserved mesh slot and resolves the launch

- **Date:** 2026-11-04
- **Status:** accepted; implemented by #97
- **Context:** #92 added synchronous-throw cleanup for the non-queued start
  path, but an asynchronous rejection from `startWorkerTurn` still rejected
  `Harness.launch` and left the picked mesh node reserved. The caller could not
  release the reservation, and a rejected launch gave no actionable failure
  record. The review of #92 recorded this as the remaining non-queued residual;
  #97 fixed it.
- **Decision:** `startNow` catches an asynchronous rejection from
  `startWorkerTurn`, releases the picked node idempotently, logs the failure,
  and resolves the launch. `activeWorkers` is left to `startWorkerTurn`'s
  `.finally`; no node is released when no node was picked. The assignment stays
  running for the Watchdog to detect, and the queued entry path is unchanged.
- **Consequences:** a failed start is visible in logs and through the stuck
  Assignment, not through `settleInflight` (the launch resolves). Capacity
  accounting is no longer lost to an asynchronous failure. The gap noted at the
  time — the Harness released the node but did not `pump()`, so an already-queued
  Worker could remain parked with a free node until a later event — was closed
  by MESH-FAILURE-PUMP (#99, `6184a27`), which releases and then pumps in both
  `startNow` failure paths.
- **Follow-up:** #99 (`6184a27`) adds release-then-`pump()` to both the
  synchronous and asynchronous `startNow` failure paths, gated on a picked
  node, and proves with a deterministic queued-Worker regression test that the
  ordering cannot double-start. It is a separate change, not part of the #97
  decision.
- **Alternatives rejected:** rethrowing to the caller (rejects
  `Harness.launch`, leaves mesh accounting to a caller that does not own it, and
  leaks the node); marking the assignment failed from the Harness (the Engine
  owns domain transitions, and the Watchdog is the established failure path).

## ADR-009 — A stale empty gateway token file fails closed and is recovered only by explicit operator action

- **Date:** 2026-11-04
- **Status:** accepted; implemented (stale-empty diagnostics and fail-closed client read)
- **Context:** `<stateDir>/gateway.token` is the gateway's self-issued local
  bearer token. `readTokenFile` trims the file and treats an empty result as
  "no token" (`src/gateway/token.ts:98-100`). `loadOrCreateGatewayToken` then
  mints a token and attempts an exclusive create
  (`src/gateway/token.ts:164-168`). If the path already exists, `O_EXCL` fails
  with `EEXIST`; the re-read still sees no token, so the call throws
  `GatewayTokenFileError(file, 'was created concurrently and is empty')`
  (`src/gateway/token.ts:140-146`). Both `ds-agent gateway`
  (`src/cli/gateway.ts:42-43`) and the embedded gateway
  (`src/gateway/embedded.ts:26`) call this before binding a port, so startup
  aborts and the file's content and inode are left unchanged. On POSIX the
  existing mode check may first tighten a loosened mode to `0600`. A
  zero-length file and a whitespace-only file behave identically.
  `startGatewayServer` has a second empty-token guard
  (`src/gateway/server.ts:250-251`), but the file path normally throws earlier.
  On the client side, `gatewayApiFromEnv` uses `readGatewayToken`, gets
  `undefined`, and silently falls back to another model source
  (`src/harness/model.ts:264-265`), so a truncated token can also cause a silent
  gateway bypass rather than a visible error.
- **Threat model:** An empty token file can be (1) a crashed first create
  (SIGKILL/power loss between `O_CREAT` and `write`, or a filesystem that
  exposes a zero-length file), (2) an in-progress create by another process
  (the race the current code deliberately protects at
  `src/gateway/token.ts:110-116`), or (3) deliberate truncation by an attacker.
  Content alone cannot distinguish them. A same-uid or root attacker can already
  read a 0600 file, so the property at stake is not secrecy against that
  attacker; it is (a) preserving a tamper signal, (b) not minting a fresh
  valid-looking credential over evidence, (c) not desynchronizing a running
  gateway from its clients, and (d) not letting a truncated token silently
  downgrade the agent to another provider path. Automatic recovery breaks all
  four.
- **Decision:** keep fail-closed and never recover automatically. An existing
  zero-length or whitespace-only token file must abort startup with a
  `GatewayTokenFileError`; the process must not delete, rename, truncate, or
  overwrite it, must leave its content and inode unchanged, and must not mint a
  token. The existing `ensurePrivateMode` check
  (`src/gateway/token.ts:57-67,99`) may tighten a loosened mode to `0600` on
  POSIX before the empty result is rejected; that is the standing security
  invariant, not recovery, and the failing path must never loosen the mode or
  use the empty content. Recovery is an explicit
  operator action: stop gateway/agent processes, inspect the file (regular file,
  `nlink == 1`, owned by the intended user, mode `0600`, parent directory not
  group/world-writable), decide whether the empty state is expected (crash) or
  suspicious (tamper), then remove the file deliberately and restart, or start
  with an explicit `--token` / `DS_AGENT_GATEWAY_TOKEN` without touching the
  file. If the state is suspicious, preserve a copy as evidence and treat the
  local token and any upstream credentials as potentially compromised before
  minting a replacement.
- **Preconditions for manual recovery:** the operator has confirmed the path is
  a plain, singly-linked, user-owned `0600` file; no concurrent first-create is
  in progress; and the state directory is trusted. Recovery must not be
  scripted as an unconditional "if empty, delete".
- **Failure behavior:** any empty token file (zero-length or whitespace-only)
  fails startup with a diagnostic that names the path and the stale-empty
  condition; content and inode remain unchanged, and on POSIX a loosened mode is
  tightened to `0600` by the existing check (it is never loosened); no token is
  returned; no port is bound. An explicit token still works because it bypasses
  the file (`src/gateway/token.ts:162-163`), but it is not persisted and every
  client must be configured with it.
- **Follow-up implementation (not in this docs PR; scope
  `src/gateway/token.ts` + tests):**
  1. Distinguish "absent" from "present but empty" inside `readTokenFile`
     (for example, return a discriminated result instead of using `undefined`
     for both). Keep every existing symlink, hard-link, and mode check.
  2. Make the startup path (`loadOrCreateGatewayToken`) throw a distinct,
     actionable error for an existing empty file, such as `gateway token file
     <path> is empty (zero-length or whitespace-only); remove it to mint a new
     token`, instead of the misleading concurrent-create message. Preserve the
     concurrent-create message for the genuine `EEXIST` race
     (`src/gateway/token.ts:140-146`).
  3. Make the client read path (`readGatewayToken`, used at
     `src/harness/model.ts:264`) fail closed on an existing empty file too, so
     truncation cannot silently downgrade to a non-gateway model; if that is
     considered too breaking, record the fallback as an explicit residual
     instead.
  4. Tests: zero-length and whitespace-only fixtures in
     `test/gateway-token.test.ts`, asserting the distinct error, unchanged
     content and inode, and a mode that is exactly `0600` after the check on
     POSIX (never looser; skip the mode assertion on win32), no new token, and
     fail-closed behavior on the client read; keep the existing
     concurrent-create test (`test/gateway-token.test.ts:29-41`). Cover the
     explicit-override bypass and a valid-token control.
  5. Do not add automatic regeneration, rename-aside, or in-place overwrite in
     this follow-up. An explicit `--rotate-token` flag is a possible later
     ergonomic addition (it would touch `src/cli/gateway.ts`), but only as an
     explicitly requested action and never the default.
- **Alternatives rejected:**
  - **Automatic regeneration when the file is zero-length, owned by the current
    user, mode `0600`, and not a symlink or hard link.** The preconditions are
    checkable, but they do not distinguish crash truncation from attacker
    truncation; regeneration erases evidence and produces a valid-looking fresh
    token. It also races with a concurrent first creator whose file is
    legitimately still empty (`src/gateway/token.ts:110-116`), and a
    check-then-unlink-then-create sequence is TOCTOU-prone. A running gateway
    or agent may keep the old token, producing `401`s that look unrelated to
    the original event.
  - **Quarantine the empty file (rename aside) and fail.** This preserves
    evidence but still mutates the live path, has the same concurrent-create
    race, implicitly gives the next start a fresh token (a two-restart silent
    recovery), and makes operator reasoning harder. Leaving content and inode
    untouched, then requiring an explicit removal, is safer.
  - **An explicit operator rotate/reset flag as the primary policy.** The
    intent is correct, but it is not needed to recover today (manual removal is
    already explicit) and would add CLI surface and persistence semantics.
    Retained only as an optional future convenience on top of fail-closed, not
    as the recovery default.
  - **Treating the empty file as a missing file and minting over it.** That
    would silently convert tampering into a new credential and could destroy a
    mid-write file. The current exclusive create already prevents this; it must
    stay.

## ADR-010 — Long-term memory recall stays lexical-first with an offline evaluation harness; embeddings stay behind a port

- **Date:** 2026-11-04
- **Status:** accepted and implemented (2026-11-04); partially superseded by
  ADR-016 (2026-11-05), which ships an optional embedding layer. The lexical
  path, evaluation harness, and ACL rules remain in force.
- **Context:** `SpillBackedLongTermMemory.query`
  (`src/memory/long-term.ts`) is word-AND substring matching over the
  lower-cased redacted spill body. Requested tags are an exact AND filter, and
  ranking is `tagHits` desc, `textHits` desc, `createdAt` desc, `id` desc. The
  M6 module row and the roadmap's 长期记忆 row still described semantic search,
  multi-hop recall, and the month-scale story as open-ended. Guessing at an
  implementation would have added either a ranking heuristic or a provider
  dependency without a measured recall problem. `test/memory-recall-eval.test.ts`
  now fixes a 14-entry redacted corpus, 11 labelled positive queries (exact,
  paraphrase/synonym, word order, tag-only, and multi-hop), and 2 negative
  controls. It runs through the real `query()` path on a temp SQLite store:
  no network, no model, no sleeps, and no product-source changes.
- **Measured baseline:** macro recall@3 is **4/11 = 0.364**. The metric is the
  fraction of each query's labelled relevant entries that appear in the top
  three results, averaged over the 11 positive queries. Breakdown:

  | Strategy | Exact (2) | Word order (2) | Paraphrase (3) | Tag-only (2) | Multi-hop (2) | Macro (11) |
  | --- | --- | --- | --- | --- | --- | --- |
  | Current `query()` | 1.000 | 1.000 | 0.000 | 0.000 | 0.000 | 0.364 |
  | (a) normalization + synonym/morphology map | 1.000 | 1.000 | 1.000 | 0.000 | 0.000 | 0.636 |
  | (a)+(b) plus tag-aware one-hop expansion | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
  | (c) embedding port with deterministic mock | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
  | (d) hybrid lexical + tag-hop + embedding | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |

  The two negative controls (`kubernetes helm chart`, `payment refund
  chargeback`) return zero results under every strategy. The exact baseline
  failures are pinned explicitly: tag-only queries return `[]`, paraphrase
  queries score 0, and both multi-hop queries score 0 because no single entry
  contains every query word.
- **Evaluation of options:**
  - **(a) Lexical normalization and a small in-repo synonym map.** NFKC,
    lower-casing, punctuation/whitespace normalization, a tiny canonical map
    (`credential`/`token`, `rotate`/`rotation`, `prune`/`pruning`,
    `old`/`older`, `entry`/`entries`, and similar), plus stop-word removal.
    Recovers all three paraphrase queries: macro rises from 0.364 to 0.636
    (+0.273 absolute). It is deterministic, has no dependency, and changes no
    authorization or redaction path. It does not recover tag-only or multi-hop
    recall (0/2 each). Risk: over-expansion can reduce precision, so the
    negative controls and exact/word-order categories must stay at their
    current values.
  - **(b) Tag/ticket hop expansion.** Tag-aware scoring makes a tag-only query
    retrievable, and one hop across a shared tag links the deploy-owner entry
    to the deploy-token/deploy-incident entries. Combined with (a), macro
    recall@3 reaches 1.000 (+0.364 over (a), +0.636 over baseline), including
    2/2 multi-hop. It is deterministic and dependency-free. The measured
    implementation relaxes the strict word-AND gate to partial-overlap scoring
    before ranking; without that, tag-only and multi-hop candidates never enter
    the result set. That relaxation is the precision risk the negative controls
    and held-out set must guard. The hop is capped at one and the index is
    capped by retention, so it does not introduce an unbounded graph walk.
    Risk: tags can be coarse; a one-hop link is a retrieval hint, not proof of
    relevance, so precision controls and a held-out query set are required.
  - **(c) Embeddings behind a pluggable port.** The harness evaluates a
    deterministic, offline mock that embeds the same canonical tokens and tags
    as a sparse vector. It reaches 1.000 on this corpus, but **adds zero recall
    over (a)+(b)**. The mock is deliberately not a neural model: it proves the
    port can be deterministic and CI-safe, not that a provider model would
    generalize. A real provider would add network latency and cost, an SDK or
    persistent vector store, nondeterminism, and a new egress path for redacted
    summaries. Because the measured corpus has no residual semantic gap after
    (a)+(b), that cost is not justified now. The port boundary is recorded
    below; it is not implemented.
  - **(d) Hybrid ranking.** A normalized lexical+hop score blended with the
    mock cosine also reaches 1.000, exactly equal to (a)+(b). It adds score
    weighting, two ranking explanations, and a provider-shaped dependency for
    no measured recall gain. Rejected until a held-out corpus shows a gap that
    lexical+hop cannot close.
- **Dimension check:**

  | Option | Recall@3 macro | Determinism | Dependency cost | Security | Month-scale |
  | --- | --- | --- | --- | --- | --- |
  | (a) normalization + synonyms | 7/11 = 0.636 | pure, stable | none | ACL/redaction unchanged | bounded scan |
  | (b) (a) + tag-aware one-hop | 11/11 = 1.000 cumulative | pure, stable | none | grants per hit; one hop only | one hop within the 1000-entry cap |
  | (c) embedding port + mock | 11/11; **zero gain over (b)** | mock deterministic; real provider is not | interface none; real SDK/vector store | new redacted-summary egress; ACL unchanged | per-entry vector storage/refresh |
  | (d) hybrid | 11/11; **zero gain over (b)** | deterministic with mock | ranking complexity; provider-shaped | same as (c) if embeddings are used | same as (c) if embeddings are used |

  This is why the decision is (a)+(b): it is the smallest measured step that
  recovers every labelled failure, and it adds no dependency, provider egress,
  or new authorization path.
- **Decision:** keep M6 recall lexical-first. The next implementation step is
  (a)+(b), not embeddings:
  1. Normalize query and body tokens (NFKC, case, punctuation, whitespace) and
     apply a small in-repo synonym/morphology map.
  2. Let query words match tags, while requested `tags` remain an AND filter,
     and add a one-hop expansion across shared tags (and ticket/thread links
     where the entry already carries them).
  3. Preserve deterministic ordering: score, then `createdAt` desc, then `id`
     desc; do not introduce randomness or a provider.
  4. Keep embeddings unimplemented. If semantic recall is revisited, it must
     sit behind an `EmbeddingPort` that accepts **already-redacted text and
     tags only**, never ticket ids or raw bodies, and must have a deterministic
     offline mock used by CI. A real provider adapter must be explicitly
     configured, never called by the default/offline suite, and must not become
     a new capability path.
- **Security:** ACL grants and redaction are unchanged. `query()` still requires
  a reader `ticketId`; every returned hit still grants that ticket access to
  the exact spill, so a memory id remains a reference, never a capability. The
  hop expansion is retrieval over the same authorized result set and must grant
  per hit; it must not expose a body without a grant. Redaction continues to
  run before the spill and summary are written. An embedding provider would be
  a new egress path for summaries even after redaction, which is another reason
  not to wire one before evidence requires it. Fixtures are synthetic and
  contain no secrets.
- **Determinism:** (a), (b), and the mock embedding are pure and deterministic;
  the test asserts identical top-three ids across repeated runs and a reopened
  SQLite store. A real embedding provider would not be deterministic by default,
  so it cannot be used in CI or as the sole ranking source without pinning a
  model/version and recording fixtures.
- **Month-scale behavior under retention defaults:** Runtime defaults are 1000
  entries / 90 days (`DEFAULT_MEMORY_MAX_ENTRIES`,
  `DEFAULT_MEMORY_MAX_AGE_DAYS` in `src/runtime.ts`); retention prunes inside
  the same transaction as writes, so the index does not grow without bound
  across months. A query scans at most that bounded set, and one-hop expansion
  is also bounded by it; there is no unbounded history or graph. The current
  scan still reads stored bodies, so the follow-up should add a 1000-entry
  fixture/benchmark to confirm the bound; wall-clock assertions should stay out
  of CI if they are machine-sensitive. Embeddings would add per-entry vector
  storage and refresh cost on top of that bound; that cost is not accepted yet.
- **Limitations of this evidence:** the corpus is synthetic and small (14
  entries, 11 positive queries), and the mock embedding is lexical. The values
  are a regression floor and a decision aid, not a generalization claim. Before
  shipping the follow-up, add at least 10 held-out queries and keep the two
  negative controls empty. Do not tune only to the original 11 queries.
- **Acceptance criteria for the follow-up task (M6
  `src/memory/long-term.ts` + tests; not this PR):**
  - On `test/memory-recall-eval.test.ts`, macro recall@3 is at least 10/11
    (0.909), exact and word-order remain 1.000, both tag-only and both
    multi-hop queries reach at least 0.5 (the targeted outcome is 1.000), and
    both negative controls still return zero results.
  - At least 10 additional held-out queries are added before merge; the
    implementation does not regress exact/word-order or make a negative control
    return a hit.
  - `query()` still throws without `ticketId`; a memory id alone cannot read a
    spill; every returned hit grants the reader ticket the spill; redaction is
    applied before storage; no new lookup-by-id API is added.
  - Deterministic id order across repeated runs and a reopened store; no
    network, model, sleep, or real channel in the test.
  - No new runtime dependency. If an `EmbeddingPort` is introduced, only its
    interface and deterministic mock are wired; no provider is called in CI and
    no embeddings are claimed as implemented.
  - Retention defaults and transactional prune remain 1000 entries / 90 days;
    add a 1000-entry fixture to prove the query remains bounded and
    deterministic.
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, the two memory test
    files, and the full offline suite stay green.
- **Implementation result (2026-11-04):** options (a)+(b) are implemented in
  `src/memory/long-term.ts`; options (c)/(d) remain rejected and embeddings
  remain unimplemented. `test/memory-recall-eval.test.ts` now measures the
  shipped `query()` path and records: original 11/11 macro recall@3 = 1.000
  (exact 2/2, word order 2/2, paraphrase 3/3, tag-only 2/2, multi-hop 2/2),
  15/15 additional held-out-style queries authored in the same follow-up PR
  (regression coverage, not a blind independent set) across paraphrase,
  morphology, tag-only, and multi-hop, and four negative controls returning
  zero results. Deterministic
  ids are asserted across repeated runs and a reopened SQLite store, and a
  deterministic 1000-entry fixture remains bounded to at most one body read per
  entry (no wall-clock assertion). `query()` still throws without a reader
  `ticketId`, every returned hit (direct or expanded) grants that ticket the
  exact spill, redaction is unchanged, and no lookup-by-id API was added. No
  new dependency, provider, network, sleep, or model call is used.
- **Alternatives rejected:**
  - **Implement embeddings now.** Zero measured recall gain over (a)+(b) on the
    fixed corpus, plus provider, dependency, egress, and nondeterminism costs.
  - **Call a live model in the recall test.** Non-deterministic, network-bound,
    and violates the offline CI contract; a mock behind a port is the only
    acceptable CI form.
  - **Unbounded tag/ticket graph traversal.** Speculative and cost-unbounded;
    one hop is enough for both measured multi-hop queries, and the retention
    cap already bounds the candidate set.
  - **Treat a memory id or a hop link as authorization.** It would turn a
    reference into a capability and bypass the reader-ticket grant; rejected
    on security grounds regardless of recall.

## ADR-011 — The model Slow Path is opt-in, fallback-first, and never bypasses the fast path

- **Date:** 2026-11-04
- **Status:** accepted; default remains deterministic ingress
- **Context:** T17 shipped a Slow Path that was only `ruleClassify`. A model
  could classify ambiguous triggers better, but a network call on every ingress
  would make the default path nondeterministic, slow, and dependent on a live
  credential. Offline CI must never call a provider.
- **Decision:**
  - Add an async `SemanticPolicy` port in `src/ingress/policy.ts`.
    `MockModel` delegates to `ruleClassify`; `HttpOpenAI` makes one
    tool-free `chat/completions` call with `temperature: 0`, a small
    `max_tokens`, an `AbortSignal.timeout` bound, and only the already-redacted
    source/addressed/text. Output is parsed strictly as exactly one JSON object
    (`pass`, `strength`, `reason`); a surrounding code fence is the only
    tolerated decoration.
  - `PolicyClassifier` races the policy against a timer, clears it, and maps a
    timeout, throw, or invalid hit to `ruleClassify(trigger)` with a
    `fallback:<timeout|error|invalid>` reason. It never rejects to ingress.
  - `filterTriggerWithPolicy` runs `fastPath` first. A fast drop returns before
    the policy is called and cannot be overridden. Only a fast pass reaches the
    model, and the combined verdict keeps the existing `FilterVerdict` labels.
  - `Runtime` defaults to `rules`. `DS_AGENT_SLOW_PATH=model` (or
    `RuntimeOptions.slowPath.mode`) opts in; `DS_AGENT_SLOW_PATH_TIMEOUT_MS`
    defaults to 3000 and is valid only from 100 to 30000. An invalid mode,
    timeout, or a model without `classifyPolicy` falls back to rules with one
    reason-only log line (fail closed).
  - `Runtime.ingestAsync` is additive. Sync `Runtime.ingest` keeps its signature
    and remains rules-only, so existing callers and A2A inbound do not change
    behavior. This PR delivers the additive entrypoint and the policy/trust
    path; the CLI `chat`, `emit`, and iMessage inbound call sites are wired to
    `ingestAsync` in a follow-up after the concurrent LOCAL-UI change to
    `src/cli/main.ts` lands, so they currently remain sync and rules-only. A2A
    inbound remains synchronous and rules-only until a separate review.
  - A model verdict is handed to `Intake` in the ingress-owned
    `TriggerTrust.admission` sidecar (`{listened, reason}`), never in
    `trigger.meta`. Intake uses that verdict instead of re-running
    `host.scope.admit`, so a model drop is durable (a `filtered` disposition)
    and a model pass is effective even when the deterministic rules would have
    said no. A fast-path denial still wins. Callers that supply no sidecar keep
    the existing re-filter behavior.
- **Consequences:** default ingress behavior, offline CI, and the sync
  `ingest` contract are unchanged. Operators can opt into a bounded,
  fail-closed model check. A policy can only narrow or widen admission after
  the fast path has passed; it cannot override an admission/source/mention/
  noise denial. Logs contain the mode, timeout, fallback cause, and sanitized
  policy reason — never the API key, request body, or raw model output.
- **Alternatives rejected:**
  - **Make the model the default Slow Path.** It would add latency, cost,
    nondeterminism, and an offline-CI network dependency to every trigger.
  - **Re-filter after the model verdict in Intake.** Rules would undo a model
    drop or reject a model-only pass; the ingress verdict must be authoritative
    once computed.
  - **Read admission from `trigger.meta`.** `meta` is adapter-controlled data;
    treating it as a decision recreates the C1 bypass.
  - **Let the model override a fast-path denial.** Admission, source, and noise
    denial are security/shape decisions, not semantic ones; a remote model must
    not widen them.
  - **Call the model without a hard timeout or tools disabled.** A hung or
    tool-using classification call would block ingress and could act beyond the
    policy contract.

## ADR-012 — Remote mesh registration, heartbeat, and dispatch are fail-closed and listener-free

- **Date:** 2026-11-04
- **Status:** accepted; implements the T47 transport half. The Runtime/CLI
  listener remains owner-gated and is not part of this decision. ADR-011
  (model slow path) merged as #128 (`788be60`); ADR-012 follows it in numeric
  order.
- **Context:** T47 placement was logical: `WorkerMeshRegistry` accounted for
  capacity, but no peer could be registered over the network and no assignment
  could leave the process. The authenticated A2A HTTP primitive (`a2a-auth.ts`,
  `a2a-http.ts`) is now merged, so the transport half can be built without
  inventing a second wire protocol or weakening the auth boundary. A peer that
  registers an endpoint is also choosing a future outbound target, which turns
  inbound registration into an SSRF-adjacent decision.
- **Decision:** add `src/harness/remote-node.ts` with two halves.
  - `RemoteMeshRegistry` registers `{ id, url, peerId, secret, capacity? }`,
    validates id/peer/url non-emptiness, the A2A minimum secret length
    (`A2A_MIN_SECRET_BYTES`), absence of URL userinfo, positive integer
    capacity, duplicate ids, and a node-count bound (default 256), and reuses
    `A2AHttpTransport`'s constructor for the https-or-loopback-http URL guard.
    It tracks heartbeat, online/offline, in-flight assignments, and a
    configurable stale window (default 60 s). `pick` is least-loaded,
    capacity-bounded, and sticky for an eligible existing assignment; a
    stale/offline/unknown assignment is released before `undefined` is
    returned so its capacity is not leaked. `dispatch` requires a prior
    `pick`/assignment, signs `{ kind: 'assignment', ticketId, assignment }` as
    the local peer with a lazily constructed per-node `A2AHttpTransport`, keeps
    the slot on `delivered`, and releases it on
    `unroutable`/`failed`/transport error or a stale/offline/unknown refusal.
    `list()` returns secret-free copies; returned deliveries never contain the
    secret or peer-supplied error text.
  - `MeshInbox`/`createRemoteMeshHandler` wraps `createA2AHttpHandler` with an
    `A2ARouter` and accepts only `register`, `heartbeat`, and `assignment`
    bodies. The A2A-verified `envelope.from` is the authoritative peer id; a
    body `from` is ignored and an outer `from` that conflicts with auth is
    rejected by the HTTP layer. `register`/`heartbeat` update the registry;
    remote-driven growth is bounded by `maxNodes` (default 256) and
    `maxAddresses` (default 64), with the same node bound applied to the
    handler's default registry. Inbound `register` rejects loopback endpoint
    hostnames by default; an operator must set
    `allowLoopbackRegistration: true` for local process tests or a deliberate
    loopback deployment. Private-network hosts remain operator policy: this
    module neither allowlists nor implicitly trusts them. Heartbeats more than
    `maxSkewMs` in the future are rejected so a peer cannot pin itself online,
    while past timestamps remain accepted. `assignment` invokes `onAssignment`
    exactly once and maps callback failures to a non-leaking 502. The callback
    is typed to return `undefined`, so TypeScript rejects an async callback;
    `AsyncFunction` and any returned thenable are also rejected before a
    delivery is reported. Unknown or malformed kinds fail closed before the
    callback. The module never constructs a Trigger and never starts a
    listener; the caller creates the `node:http` server.
- **Trust boundary:** the A2A v1 canonical string binds the peer and body, not
  the target host/path/method, and the default replay cache is process-local.
  Every verifier sharing a secret MUST either use a unique per-verifier secret
  or pass a shared replay cache (preferably both). This module stores outbound
  secrets in memory only; it does not distribute, rotate, persist, or log them.
  `list()` and dispatch results are secret-free. The inbound mesh endpoint is
  authenticated but not authorized for anything beyond the three body kinds.
  Authentication does not make a peer-supplied outbound URL safe: loopback
  targets are rejected unless the operator opts in, and private-network
  reachability remains an operator policy decision rather than an implicit
  capability.
- **Deliberate non-goals:** no Runtime or CLI listener, no scheduling/queue
  integration, no remote Worker execution claim, no key storage/distribution,
  no persistence of registry state, no Trigger construction, no general
  network egress allowlist, and no new dependency. A later owner-gated wiring
  change owns mounting the handler and connecting `onAssignment`.
- **Consequences:** the tested client/registry and receiver callback seam exist
  without changing default Runtime behaviour. A remote assignment is only a
  delivery result; it never proves the peer executed anything. Losing the
  process loses the registry and ticket stickiness. Capacity is local to each
  registry, so two routers can over-book the same peer unless an operator
  partitions tickets or capacity. Remote-driven node/address growth is bounded,
  and short secrets, credential-bearing URLs, loopback registrations, and
  future heartbeats fail at the boundary instead of degrading into generic
  dispatch failures. Operators who opt into loopback registration own that
  egress decision.
- **Alternatives rejected:**
  - **Add an unauthenticated JSON POST endpoint.** Bypasses the merged A2A
    signature, timestamp, and replay checks.
  - **Start the listener in `Runtime.create`.** Changes default process
    behaviour and network exposure; the owner gate is explicit.
  - **Reuse one secret for every verifier with the process-local cache.** A
    captured request can replay to another verifier inside ±60 s; the shared
    secret/shared cache requirement above is mandatory.
  - **Allow peer-registered loopback URLs by default.** Any authenticated peer
    could make this process POST to unrelated local services; the A2A guard
    cannot express that policy.
  - **Retry or throw peer error text from `dispatch`.** Leaks peer-controlled
    strings and can duplicate assignments; failure releases the slot instead.
  - **Auto-pick inside `dispatch`.** Hides placement from the caller and
    bypasses the explicit `pick`/capacity contract.
  - **Await an async `onAssignment`.** The A2A HTTP router seam is synchronous;
    an async callback could keep working after the sender was told the delivery
    failed. The contract is synchronous and the type rejects `Promise` returns.

## ADR-013 — The local UI is a read-only, token-gated projection of persisted state

- **Date:** 2026-11-04
- **Status:** accepted; #129 merged the server and #136 wired the command
- **Context:** Operators need to see tickets, threads, outbox metadata, health,
  and lifecycle events without holding a Session or starting a model. Persisted
  lifecycle payloads can contain titles, thread keys, guidance text, and
  speculative work; the bus itself is not an authorization boundary. A network
  UI would add accounts, TLS, and a much larger exposure surface.
- **Decision:** `src/ui/server.ts` serves one `buildSnapshot()` read model to
  HTML, `/api/snapshot`, and SSE. It binds `127.0.0.1` only and refuses any
  non-loopback host. A token of at least 16 characters is mandatory; comparison
  uses SHA-256 digests and `timingSafeEqual`. The `GET /?token=` bootstrap
  exchanges the token for an HttpOnly SameSite=Strict cookie and a clean 303.
  Auth precedes routing; only `GET /health` is unauthenticated and state-free.
  All routes are GET. The read model hides speculative tickets from tickets,
  outbox, events, and thread subscriptions; outbox text is omitted; lifecycle
  events are rebuilt from a per-kind whitelist and events for invisible tickets
  or unknown kinds are dropped. Metrics are re-read from disk on each frame.
  The UI never writes domain state and never calls `Metrics.flush()`. SSE uses a
  bounded drain wait rather than unbounded buffering. `ds-agent ui` wires the
  command in `main.ts`; token and loopback enforcement stay in `runUi`.
- **Consequences:** the UI is single-user and local-trust. The token appears
  once in browser history during bootstrap; any same-uid process that can read
  the environment or state directory can still reach loopback. There is no
  TLS, account system, remote bind, or mutation path. Those remain external
  decisions, not hidden capabilities.
- **Alternatives rejected:**
  - **Token-optional or no auth.** State includes ticket titles and thread keys;
    loopback is not an authorization boundary.
  - **Render raw lifecycle payloads.** Persisted payloads are caller-supplied
    and can carry secrets or speculative titles.
  - **Separate read models for HTML/JSON/SSE.** They drift and one surface
    eventually leaks what another filters.
  - **Remote bind in this change.** Requires TLS, accounts, and a threat model
    of its own.

## ADR-014 — Backup is a verified snapshot; restore is force-gated and reversible

- **Date:** 2026-11-04
- **Status:** accepted; #131 merged backup/restore and release checks
- **Context:** The SQLite store is the durable domain state. A naive file copy
  of a live WAL database is not a consistent snapshot, and a restore that
  overwrites `ds-agent.db` can destroy the only copy on a failed copy. Operators
  also need a non-destructive release gate.
- **Decision:** `backupStore` runs `PRAGMA integrity_check` on the source,
  refuses newer schemas, uses `VACUUM INTO` a unique temp file in the output
  directory, verifies the temp snapshot's integrity and ledger, computes
  SHA-256, and installs it with `fs.linkSync(temp, out)`. `EEXIST` is treated
  as a race loss: the existing output is preserved, never deleted. The live
  source is never modified. `restoreStore` requires `--force` when a store
  exists, integrity-checks the backup, verifies the candidate before install,
  moves the old DB plus WAL/SHM sidecars to
  `<state-dir>/backups/pre-restore-<timestamp>.db*`, and rolls back on failure.
  The release check validates semver, bin/dist entries, rules assets, and
  `npm pack --dry-run`; the GitHub release workflow is manual (merged in #132
  `a1985c0` without recorded owner approval; audited as `workflow_dispatch`,
  `contents: read`, no secrets, no publish).
- **Consequences:** the daemon must be stopped before restore; backup and
  install require a filesystem that supports hard links in the same directory.
  Backups are plaintext SQLite and inherit the state directory's permissions.
  Publishing is not automated and remains an owner decision.
- **Alternatives rejected:**
  - **Copy the live DB/WAL files.** Not a consistent snapshot.
  - **Overwrite the target unconditionally.** Can delete a race-created or
    pre-existing backup and leaves no rollback.
  - **Auto-publish from the release workflow.** Needs secrets and production
    authority the program does not have.

## ADR-015 — Memory follows the article's object graph, Router decision memory, and two-tier retention

- **Date:** 2026-11-04
- **Status:** accepted and implemented (2026-11-04).
- **Context:** ADR-010 made long-term recall lexical and deterministic, but the
  article's §3.3 Chain of Recall is an **object graph**: every Trigger, Thread,
  and Worker Session gets an id; each injected object inlines the ids of its
  tightly related neighbours; a recalled object inlines the next hop. The
  shipped `read_object` only paged a spill body and returned no neighbours, and
  §2.1's Router was described as the global sequence point and memory while the
  implementation only remembered finished Tickets. §8.1 names month-scale
  memory as the remaining scalability bottleneck.
- **Decision:**
  1. **Typed handles and refs.** `src/memory/graph.ts` defines one handle per
     object (`trigger:<id>`, `thread:<key>`, `ticket:<id>`, `decision:<id>`,
     `session:<id>`, `channel:<source>:<thread>`, `actor:<source>:<id>`).
     `refsForTrigger`, `refsForTicket`, and `refsForDecision` build one-hop
     ref lists; `inlineOrSpill` returns them alongside the inline result, the
     Router/Worker task lines carry `refs=`, and the same list is persisted on
     the spill. The trigger text stays clean for user-facing acknowledgements.
  2. **Schema v4.** `spills.refs` stores that JSON list. Existing rows default
     to `[]`; body and grants are untouched.
  3. **Chain of Recall is resolved, not trusted.** `read_object` accepts a
     spill id or a `kind:id` handle. `readObjectFor` re-checks the reader
     ticket on every hop: trigger/thread/ticket/decision require a shared
     Thread; a session requires the caller's own session. A handle never
     becomes a capability.
  4. **Router global memory.** Every persisted Decision (accept, ignore, stop,
     unavailable) becomes a `kind=decision` LTM entry with thread/ticket/
     trigger refs. The Router prompt and main-agent assessment receive
     `recentDecisions()` (the global sequence point) plus
     `forThreads(ticket.threadKeys)`, so a same-Thread decision is visible
     without a lexical title match and a cross-channel decision can steer a
     new Ticket. The Worker receives lexical query hits plus the same-Thread
     entries.
  5. **Long-range memory.** Hot ticket/decision entries keep the existing
     1000-entry / 90-day bound. Before a hot entry is pruned, its summary is
     folded into one bounded cold Thread digest (200 entries / 3650 days).
     `query({ tier: 'cold' })` searches the digests. This is the concrete
     answer to §8.1: month-scale recall does not require unbounded history.
  6. **The Router is a resident Session.** `Runtime.start()` arms every
     configured shard before recovery or assessment. `Harness.armRouter`
     persists one `sessions` row per shard and appends `session.started`;
     a later process keeps the original `createdAt` and appends
     `session.resumed`. Every admitted or filtered Trigger, Decision, Ticket
     created/ended event, and assessment outcome is appended as a redacted,
     bounded `observe.*`/`assessment` entry. Router turns and main-agent
     assessment share the shard's Session chain (`routerExclusive`), and
     assessment receives `routerHistory()` as `routerSession`. The observed
     entries have no model role, so they are durable Session memory rather
     than fabricated user turns in the replay.
- **Security:** redaction runs before every spill and summary. `query()` still
  requires a reader `ticketId` and grants each hit. `readObjectFor` resolves
  only ids and re-checks the reader's Thread relation; it does not grant the
  target. `ltm` ids remain references, not capabilities.
- **Determinism:** refs are plain JSON, ordering is stable, and handle
  resolution is synchronous over SQLite. No network, model, provider, or
  wall-clock-dependent ranking is added. Hot/cold pruning uses the injectable
  clock and runs inside the write transaction.
- **Retention defaults:** hot 1000 / 90 days; cold 200 / 3650 days. Both are
  configurable (`DS_AGENT_MEMORY_MAX_ENTRIES`, `DS_AGENT_MEMORY_MAX_AGE_DAYS`,
  `DS_AGENT_MEMORY_COLD_MAX_ENTRIES`, `DS_AGENT_MEMORY_COLD_MAX_AGE_DAYS`) and
  `0` disables a dimension.
- **Evidence:** `test/memory-graph.test.ts` covers spill refs, trigger→thread→
  ticket hops, cross-ticket denial, decision memory, and cold-digest creation.
  `test/long-term-memory.test.ts`, `test/memory-recall-eval.test.ts`,
  `test/spill.test.ts`, and `test/store-migration.test.ts` remain green;
  schema v4 upgrades a legacy database without rewriting body rows.
- **Alternatives rejected:**
  - **A separate graph database or unbounded edge table.** The existing JSON
    documents and spill refs already carry the same ids; a new store would add
    migration and query cost without a measured need.
  - **Making a ref a capability.** It would let any recalled id read an
    unrelated Ticket's body and bypass the per-hit grant.
  - **Remembering only Tickets.** It loses mid-task Router decisions (the
    "plan A then plan B" case) and makes the Router's global memory a fiction.
  - **Keeping pruned history forever.** It contradicts §8.1's cost concern;
    bounded cold digests preserve the summary without unbounded growth.

## ADR-016 — Semantic recall ships as an optional, bounded hybrid layer behind `EmbeddingPort`

- **Date:** 2026-11-05
- **Status:** accepted and implemented (PR #152).
- **Context:** ADR-010 deferred embeddings until evidence required them and
  required any future attempt to sit behind an `EmbeddingPort`, use only
  redacted text, and keep CI offline. The competitive gap analysis still lists
  semantic recall as a P1 difference from Instinct and Muse. A learned
  provider cannot be a CI dependency, and indexing a whole ticket body
  (title + brief + report) against a short title query dilutes the cosine
  below any useful floor.
- **Decision:**
  1. **Two-method port.** `EmbeddingPort` (`src/memory/embedding.ts`) is
     `{ id, embed(text) }`. The shipped `HashedEmbedding` uses signed feature
     hashing over the character trigrams of `#word#`, 128 dimensions, and
     L2 normalization. It is deterministic, offline, and dependency-free.
     `src/memory/text.ts` owns the normalizer and synonym map shared with the
     lexical path, so the two candidate spaces cannot drift.
  2. **Index the head, not the body.** The memory layer embeds the first
     non-empty line, capped at 300 characters. For a ticket that is the title;
     for a decision it is the reason; for a cold digest it is the newest
     archived summary. This keeps a short query from being diluted by a long
     report while storing one vector per entry.
  3. **Hybrid ranking.** An entry is eligible when it is a lexical direct
     candidate, is reached by the existing one-hop tag walk, or its cosine
     clears `embeddingFloor` (default 0.35, clamped to 0..1,
     `RuntimeOptions.embeddingFloor` or `DS_AGENT_EMBEDDING_FLOOR`). Semantic
     candidates never seed a hop. Ordering adds `similarity` after `hopScore`.
  4. **Default on, explicitly off.** The Runtime constructs `HashedEmbedding`
     by default. `embeddings: false` or `DS_AGENT_SEMANTIC_RECALL` set to
     `0`, `false`, `off`, `no`, or empty disables it. An explicit
     programmatic port wins over the environment.
  5. **Fail open to lexical-only.** A provider throw during a write leaves the
     entry without a vector and does not abort the write. A provider throw
     during a query disables the semantic branch for that query; lexical and
     tag-hop results are still returned.
  6. **Bounded backfill.** Vectors carry a port id that includes their
     dimensions and are recomputed when it changes. A read calls the port for
     at most `MAX_EMBEDDING_BACKFILL` (32) uncached entries and persists the
     results; entries beyond the budget are scored on a later read once the
     earlier ones are cached. Upgrading a 1000-entry index therefore cannot
     turn one recall into 1000 sequential provider calls or an unbounded write
     transaction. An empty provider result is not cached, so a transient empty
     response cannot permanently disable an entry.
  7. **Security is unchanged.** Redaction runs before every port call, on
     writes and on the query text. Every returned hit, semantic or lexical,
     still grants the reader ticket access to that exact spill. No new
     lookup-by-id path is added.
- **Consequences:** the shipped hashing catches morphology, shared stems,
  word-order variation, and typos for words outside the synonym table. It does
  **not** catch true synonyms ("invoice" vs "billing"); that remains a reason
  to inject a learned provider. Stored vectors add roughly 1 KB per entry,
  bounded by the existing 1000-hot / 200-cold retention defaults. The
  lexical recall evaluation remains the regression floor; `test/semantic-
  memory.test.ts` covers the vector path, the precision floor, provider
  failure, lazy backfill, and Runtime configuration.
- **Alternatives rejected:**
  - **Embedding the whole body.** Measured cosine for a short title against a
    30-sentence report stays near 0.14, so the feature would be inert for real
    tickets.
  - **A hosted embedding provider by default.** It adds network egress,
    non-determinism, and an outage path to the default suite. The port is the
    extension point.
  - **Lowering the floor to force matches.** Unrelated hashed text scores
    around 0.1-0.2; a lower floor turns recall into noise.
  - **Writing every missing vector during a query.** It makes a read an
    unbounded write and blocks recall behind the slowest provider call.
