# Architecture decisions

Record decisions that change or clarify a boundary. Do not use this file to
rewrite `PLAN.md`; link to the contract instead.

## ADR-001 — iMessage admission fails closed

- **Date:** 2026-11-03
- **Status:** accepted, implementation in progress (`IMESSAGE-ADMISSION`)
- **Context:** `#64` marked every iMessage trigger `addressed: 'direct'`. The
  fast path admits `direct` before admission rules, and `--handle` was optional.
  Any sender in any chat could trigger work.
- **Decision:** require a sender allowlist (`--handle` or
  `DS_AGENT_ACTOR_ALLOWLIST`) unless the operator passes an explicit
  `--allow-any` opt-out. Group chats are closed by default and require an
  explicit `--allow-groups`. A group message is never `addressed: 'direct'`.
- **Consequences:** default open use now fails with a clear error. Operators who
  need any-sender behavior must opt in and see a warning. Tests cover the
  refusal, the 1:1 path, and group filtering.
- **Alternatives rejected:** relying on the existing ingress actor allowlist
  (optional and not enforced by the channel); content-based mention detection
  (untrusted and brittle); treating group chats as direct (unsafe).

## ADR-002 — Mesh backpressure is process-local and Harness-owned

- **Date:** 2026-11-03
- **Status:** accepted, implementation in progress (`P1-3`)
- **Context:** `WorkerMeshRegistry` reports capacity, but `Harness.launch`
  ignored `undefined` and ran the Worker anyway. Capacity was advisory.
- **Decision:** keep the registry as pure accounting. Add a bounded FIFO pending
  queue to the Harness. A Worker starts only after `pickNode` succeeds. Pump the
  queue on ticket release. The queue is explicitly process-local; restart
  recovery is a separate concern (ADR-004) and does not claim persistence.
- **Consequences:** no Worker runs above configured capacity. A full queue
  rejects the launch without throwing; the ticket remains open for retry/drain.
  Drain clears the queue and resolves waiters instead of hanging.
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
- **Status:** proposed (P1-6, after P1-3)
- **Context:** a killed process leaves a running assignment and a session
  journal. Replaying the exact turn is not possible, and external side effects
  may already have occurred.
- **Decision:** on startup, end the interrupted assignment through the Engine,
  create exactly one replacement assignment, append a `RECOVERED` prompt, and
  relaunch only with a live model and an unpaused ticket. Document at-least-once
  semantics; do not claim exactly-once.
- **Consequences:** no ticket stays permanently `running` after a restart.
  Recovery is idempotent. A MockModel start records the recovery event but does
  not consume deferred work.
- **Alternatives rejected:** silently re-running the journal (duplicates side
  effects without a record); leaving the watchdog to clean up (can take a full
  stale window and fails permanently if no daemon runs).
