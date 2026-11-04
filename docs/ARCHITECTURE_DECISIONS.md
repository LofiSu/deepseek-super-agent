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
- **Status:** accepted; diagnostic implementation follow-up not started
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
  aborts and the file is left byte-for-byte and inode-for-inode untouched. A
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
  `GatewayTokenFileError`; the process must not delete, rename, truncate,
  chmod, or overwrite it, and must not mint a token. Recovery is an explicit
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
  condition; the file and its metadata remain unchanged; no token is returned;
  no port is bound. An explicit token still works because it bypasses the file
  (`src/gateway/token.ts:162-163`), but it is not persisted and every client
  must be configured with it.
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
     `test/gateway-token.test.ts`, asserting the distinct error, no
     content/inode/mode change, no new token, and fail-closed behavior on the
     client read; keep the existing concurrent-create test
     (`test/gateway-token.test.ts:29-41`). Cover the explicit-override bypass
     and a valid-token control.
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
    recovery), and makes operator reasoning harder. An untouched file plus an
    explicit removal is safer.
  - **An explicit operator rotate/reset flag as the primary policy.** The
    intent is correct, but it is not needed to recover today (manual removal is
    already explicit) and would add CLI surface and persistence semantics.
    Retained only as an optional future convenience on top of fail-closed, not
    as the recovery default.
  - **Treating the empty file as a missing file and minting over it.** That
    would silently convert tampering into a new credential and could destroy a
    mid-write file. The current exclusive create already prevents this; it must
    stay.
