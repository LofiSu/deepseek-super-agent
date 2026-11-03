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
