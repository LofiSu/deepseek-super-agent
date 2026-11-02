# Module reference — M0–M11 (2026-11-02)

The Runtime assembles the modules below on every run. Routing shards, Worker
mesh placement, long-term memory, lifecycle events, and A2A are services inside
their owning M module; they are not a separate feature gate.

| Service | Owning module | Source |
|---------|---------------|--------|
| Router shards | M4 Ingress | `src/ingress/shards.ts` |
| Worker mesh | M1 Harness | `src/harness/mesh.ts` |
| Long-term memory | M6 Memory | `src/memory/long-term.ts` |
| Lifecycle events | M3 Engine | `src/core/lifecycle.ts` |
| A2A | M8 Channels | `src/channels/a2a.ts` |

```bash
DS_AGENT_INSTANCE_ID=alpha pnpm ds-agent chat "fix the login timeout"
DS_AGENT_INSTANCE_ID=alpha pnpm ds-agent memory
DS_AGENT_SHARDS='[{"id":"github","filter":"source:github"}]' pnpm ds-agent chat "CI failed"
pnpm bench:bakeoff                            # live model; dual vs single session
```

## M0 — shared

`types.ts` owns the domain contracts, including `TriggerTrust.shards`,
`Disposition.shards`, and `Assignment.node`. `ports.ts`, `errors.ts`,
`events.ts`, `log.ts`, and `boundary.ts` complete the shared layer. No Node I/O
and no imports from higher modules.

## M1 — harness

`loop.ts` runs Router/Worker turns, async jobs, guidance injection, and the
Worker task. `session.ts` maps a shard to `router:<shard>` (the default shard
keeps `router`). `mesh.ts` tracks online nodes, capacity, and in-flight tickets:

- `pickNode(ticketId)` is least-loaded and stable for a ticket.
- The chosen node is written to `Assignment.node`, the `assignment.placed`
  event, and the Worker task prompt (`node=`).
- `release` frees the slot on every terminal ticket path.

Placement is logical: this process still executes the turn. A remote hands
transport is an integration concern outside this repo.

## M2 — store

`sqlite.ts` provides atomic document/spill operations, `replaceSpill` upsert,
`deleteDoc`, and the persisted document tables used by memory (`ltm`) and A2A
(`a2a`). `schema.ts` and `spill.ts` define the tables and spill files.

## M3 — engine

`engine.ts` wires Intake → Evals → Tickets → Assignments → Replies. `lifecycle.ts`
is the read-model event bus:

- Events: `ticket.created`, `ticket.ended`, `ticket.paused`,
  `ticket.guidance`, `ticket.resumed`.
- `subscribe(kind, listener)` and `snapshot(limit)` serve a panel or CLI that
  never holds a Session.
- The Runtime publishes from `onTicketCreated`/`onTicketEnded` and from
  pause/intervene/resume.

`assessment.ts` is the deterministic Gate; the Router can veto with
`assess_trigger`. Stop/ignore paths still end the ticket before the Worker chain.

## M4 — ingress

`filter.ts` is the fast path plus the semantic rule classifier; admission is
computed from the ingress-owned `TriggerTrust`, never from `trigger.meta`.
`shards.ts` adds ordered predicates over `source`, `thread`, `actor`, `human`,
and `text`; comma joins with AND.

- `RouterShardRegistry.route(trigger)` returns every matching non-default shard
  in priority order, or `['default']`.
- The shard list is stored in `TriggerTrust.shards` and `Disposition.shards`.
- The Harness runs one Router session per matching shard, then starts the Worker.
- Configure with `DS_AGENT_SHARDS` (JSON) or `RuntimeOptions.routerShards`.
  Malformed JSON is logged and ignored, leaving the default shard.

## M5 — subscribe

`core/subscribe.ts` implements handback: it removes the ticket from the Thread,
requeues the trigger for Eval, and drops `bypass=subscription` for that ticket.
`intake.ts` handles fan-out, context-only subscriptions, and the human follow-up
bypass. `tickets.ts` owns `subscribe`/`hide` and `Engine.subscribe`.

## M6 — memory

`recall.ts` stores large bodies as spill and returns an inline summary.
`long-term.ts` persists one entry per finished ticket:

- On every terminal path, `remember(ticket)` upserts `ltm_<ticketId>` with the
  title, brief, and last report, then grants the ticket access to its spill.
- Text is redacted before it reaches the spill, including `put()` callers.
- The next ticket queries by title (three most recent hits), receives a spill
  grant for each hit, and gets `memory=<id> spillId=<id> text=<summary>` lines
  in the Worker task.
- Recall requires the reader ticket id; an `ltm` id alone is not a capability.

## M7 — speculate

`speculate/silent.ts` creates silent Assignments; `gate.ts` decides deliver or
discard with a clause-local verdict. A discarded ticket ends without outbox;
a delivered one clears `speculative` and emits `speculate.delivered`.

## M8 — channels

`norms.ts` enforces channel formatting; `cli.ts`, `feishu.ts`,
`github-source.ts`, and `outbox-adapter.ts` are the real adapters. `a2a.ts` is
the inter-instance channel:

- `A2ARouter` validates non-empty `from`/`to`, serializable bodies, and a 64 KiB
  cap; `send` assigns `id`/`at` and persists them.
- Delivery status is `delivered | unroutable | failed`.
- The Runtime registers its instance id as a local recipient. An envelope body
  `{ text, thread? }` (or a plain string) becomes a normal `a2a` source Trigger;
  it still passes the ingress filter and cannot self-admit. `human` is always
  false here; only an authenticated adapter may construct a human Trigger.
- `runtime.sendA2A(to, body)` is the outbound API. Cross-process delivery uses
  the same envelope over an external transport; transport authentication is
  external. Do not expose the local endpoint over an unauthenticated wire.

## M9 — env

`local-env.ts` confines work to `<stateDir>/workspaces`, caps output, and kills
the process group on timeout. `sanitize.ts` keeps credential values out of tool
output and prompts. `vault.ts` exposes FileVault names only. `seccomp.ts` adds
optional `sandbox-exec` / `bwrap|unshare` when `DS_AGENT_SANDBOX=1`; a real
host boundary still needs a default-deny profile or a container.

## M10 — watchdog

`watchdog.ts` runs the timer, detects stalled assignments, repeated job
failures, and marker-based goal drift (a running report that says it left the
ticket scope), and emits nudge/fail actions. `health.ts` is the offline probe.
`rules.ts` + `rules.json` hold the NL-maintainable rules.

## M11 — CLI and demo

`src/cli/main.ts` exposes `init`, `tasks`, `status`, `health`, `chat`, `emit`,
`metrics`, `memory`, `a2a`, `pause`, `intervene`, `resume`, `collab`, `team`,
and `teams`. `src/cli/demo.ts` drives the acceptance scenarios against the real
GitHub/Feishu channels and a live model. `src/cli/bakeoff.ts` compares the
dual-layer path with `RuntimeOptions.singleSession`.

`ds-agent memory [--limit N]` prints persisted long-term memories;
`ds-agent a2a [--limit N]` prints persisted A2A envelopes. Both are offline
reads over SQLite.

## T45 — metrics and bake-off

- `model.call` counts every completion alongside the existing counters and
  `curveSamples` latency samples.
- `compareBakeoff` reports extra model calls, tickets per call, and the
  wall-clock ratio.
- `pnpm bench:bakeoff` runs the same IM trigger through both modes with a live
  model and prints the comparison; `DS_AGENT_BAKEOFF_DEADLINE_MS` bounds each
  run (default 60 s).

## T51 — security and privacy

In-repo controls: env allowlist, redaction before spill and memory storage,
`[redacted]` tool output, FileVault names only, optional OS sandbox, spill ACL,
and untrusted `meta` rejection. Managed credentials and host-level seccomp stay
external as PLAN §9 says.

## Tests

```text
npx vitest run test/runtime-integration.test.ts   8 tests: shards, mesh, memory, lifecycle, A2A, bake-off
npx vitest run test/router-shards.test.ts          route/priority/filter contracts
npx vitest run test/worker-mesh.test.ts            capacity/least-loaded/release
npx vitest run test/long-term-memory.test.ts       persistence, ACL, redaction
npx vitest run test/lifecycle-a2a.test.ts          lifecycle bus + envelope delivery
npx vitest run test/runtime-wiring.test.ts         default-path service construction
npx vitest run test/cli-memory-a2a.test.ts         offline operator views
npx vitest run test/metrics-curve.test.ts          percentiles + bake-off math
pnpm typecheck                                     pass
offline CI (DS_AGENT_ALLOW_MOCK_FIXTURE=1)         195 passed, 15 skipped, 34 files
pnpm test (live Magpie, final tree)                207 passed, 3 skipped, 34 files (431.12 s)
```

The service contract suite is deterministic and offline; none of it needs a
model key.

Live reference run (Magpie, 45 s deadline per mode):

```text
pnpm bench:bakeoff                               dual 10 / single 7 model calls
                                                 wall 34.5 s vs 24.9 s (1.39x)
                                                 verdict: dual paid 3 extra calls for Router sequencing
```
