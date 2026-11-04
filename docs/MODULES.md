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
| A2A | M8 Channels | `src/channels/a2a.ts`, `src/channels/a2a-transport.ts` |

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
- The chosen node is written to `Assignment.node` by `Engine.assignmentPlaced`
  (the Engine remains the only writer), which also records the
  `assignment.placed` event. The Harness only supplies the node and includes
  `node=` in the Worker task prompt.
- `release` frees the slot on every terminal ticket path.

Placement is logical: this process still executes the turn. The transport half
of T47 is implemented in `src/harness/remote-node.ts`: `RemoteMeshRegistry`
registers peers with validated https/loopback endpoints, minimum-length secrets,
and no URL userinfo; tracks heartbeat/capacity with a 60 s stale window and
bounded node counts; picks a least-loaded eligible node and releases
stale/offline assignments; and dispatches assignment envelopes fail-closed.
`MeshInbox` / `createRemoteMeshHandler` is the authenticated receiver seam,
bounds inbound nodes and addresses, and rejects peer-registered loopback
endpoints unless the operator opts in; its assignment callback is synchronous.
The module starts no listener and makes no remote-execution claim; mounting it
in Runtime/CLI remains owner-gated.
Capacity is enforced in-process with a bounded FIFO queue owned by the Harness
(the registry stays pure accounting):

- When every node is full, `launch` does not start the Worker. It parks the
  ticket and records `mesh.queued`.
- `DS_AGENT_MESH_QUEUE` (default 100) bounds the wait list. A full queue logs
  `mesh.queue-full`, increments `mesh.queue_rejected`, and resolves the launch
  without throwing; the ticket stays open for a later retry.
- On ticket end the host releases the slot and calls `Harness.release`, which
  pumps FIFO. The Engine's assignment-ended hook also releases when a
  `blocked`/`failed`/`waiting` report ends the Assignment but leaves the
  Ticket open.
- The pump re-reads the ticket and skips missing, ended, or paused work.
  Metrics: `mesh.queued`, `mesh.dequeued`, `mesh.queue_rejected`,
  `mesh.queue_drained`.
- `drain()` clears the queue, resolves queued launch promises, logs
  `mesh.queue_drained count=N`, and leaves those tickets open. This is the
  explicit shutdown path; `jobsSettled()` waits for queued Workers to run
  instead of dropping them.

`launch` resolves when the Worker turn completes, when a full queue rejects it,
or when `drain()` releases it.

`ds-agent serve` runs the in-process watchdog/daemon timer over persisted SQLite
state and owns one Runtime for the process lifetime. It starts no inbound channel
loop, so triggers written by a separate `emit`/`chat` process are not picked up.
The model is resolved once at `Runtime.create`; changing credentials requires a
restart. With no provider key it falls back to MockModel, and Gate-deferred
assessments stay queued for a live-model start (they run at startup only when a
live model is configured). `chat` and `serve` may run on MockModel;
`demo`/`retry`/`resume` require a live model.

On the first SIGINT/SIGTERM, `serve` calls `Runtime.finish()` — settling Main
Agent assessments and Harness jobs, stopping the daemon timer, and closing SQLite
— then exits 0. A second signal force-exits 1 if that drain hangs. `finish()`
stops the daemon and closes SQLite even when a drain step rejects.

Restart replay remains a boundary: an in-flight turn is not reconstructed after a
restart, and unfinished jobs/sessions are not replayed. This is deliberate and
documented, not hidden behavior.

`prompts.ts` assembles the stable system-prompt stack in dependency order:
identity, owner persona, standing instructions, owner context, team, skills,
reach, rules, memory guidance, style, long tasks, then the role contract. The team layer names
configured local specialist agents by id and description only; their command,
environment, and limits stay in `local-agents.json`. The skills layer lists
owner-authored playbooks by id and description only; `read_skill` loads one
body on demand and cannot grant a tool or widen a role. `PERSONA.md`,
`AGENTS.md`, and `USER.md` in the agent home refine the owner-editable layers;
`DS_AGENT_PERSONA` / `DS_AGENT_INSTRUCTIONS` / `DS_AGENT_OWNER` seed them when a
file is absent. Files are capped and never override the rules or the role.
Turn facts (principal, channel, recalled memory, clock, task) stay in the turn
prompt so the system prefix remains cacheable. `ds-agent prompt --layers` shows
the stack and each layer's source; see `docs/PROMPTS.md`.

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
- History is a bounded ring: the newest 1000 events are kept by default
  (constructor-configurable, invalid capacities throw). It is **in-memory only**,
  so a panel can replay the current process but not a process that has exited.

`policy.ts` is the deterministic Gate: it handles stop/ignore/unavailable
commands and the configured auto-accept classes, and defers the rest.
`assessment.ts` then runs the Main Agent, which originates
`accept`/`ignore`/`stop`/`unavailable` (and `title`/`scope`/`strength` on accept)
before any Ticket is created. The Gate is rule/policy based; it is not a model
verdict, and the Main Agent is not consulted when the Gate already decided.

## M4 — ingress

`filter.ts` is the fast path plus the deterministic semantic classifier
(`ruleClassify`), which both `MockModel` and `HttpOpenAI` use; no model-backed
policy classifier is wired, and `test/slow-path-policy.test.ts` pins that
classification is network-free. Admission is computed from the ingress-owned
`TriggerTrust`, never from `trigger.meta`.
`shards.ts` adds ordered predicates over `source`, `thread`, `actor`, `human`,
and `text`; comma joins with AND.

`filter.ts` also owns the T16 admission rules (`AdmissionRules`): an actor
allowlist, a group/chat allowlist, and a drop-self deny list. They run on the
fast path before mention/keyword, so a denied trigger cannot be admitted by an
@-mention. The group id comes from the channel address
(`trigger.channel.address.group`); `trigger.meta` is never consulted, and a
missing group is denied while the group list is active. The shipped Feishu
adapter maps `message.chat_id` to both `address.chat_id` and `address.group`;
other adapters must populate `address.group` if they want group admission,
otherwise every trigger they emit is denied while the list is active. These
are admission filters, not authentication: a channel adapter must still verify
its peer.
A trigger that failed admission is persisted with `Disposition.filtered`.
Assessment (`Runtime.assessPending`) and Eval (`Evals.evaluateDue`) skip and
clear such an id from `Thread.pending`; handback throws a `UserError`, and
eval-driven accept (`Evals.commitAssessed`/`decide`) refuses as well. A denied
trigger therefore cannot become a Ticket without a fresh admission decision.
Configure with `RuntimeOptions.admission` or the comma-separated
`DS_AGENT_ACTOR_ALLOWLIST`, `DS_AGENT_GROUP_ALLOWLIST`, and
`DS_AGENT_DROP_SELF` variables; explicit options win, entries are trimmed and
empty entries are dropped for both env and explicit options, and unset lists
leave the fast path unchanged. An explicit `[]` still disables that rule.
Active rules are logged once at `Runtime.create` as
`[ingress] admission ...` (empty lists are not logged); a non-noise drop logs
`[ingress] dropped reason=<layer>:<reason>`.

- `RouterShardRegistry.route(trigger)` returns every matching non-default shard
  in priority order, or `['default']`.
- The shard list is stored in `TriggerTrust.shards` and `Disposition.shards`.
- The Harness runs one Router session per matching shard, then starts the Worker.
- `Runtime.start()` arms every shard as a resident Session before recovery or
  assessment. The `sessions` row persists across Tickets; a later process keeps
  its `createdAt` and journals `session.resumed`.
- Configure with `DS_AGENT_SHARDS` (JSON) or `RuntimeOptions.routerShards`.
  Malformed JSON is logged and ignored, leaving the default shard.

## M5 — subscribe

`core/subscribe.ts` implements handback: it removes the ticket from the Thread,
requeues the trigger for Eval, and drops `bypass=subscription` for that ticket.
It throws `UserError` for a trigger whose `Disposition.filtered` is defined
instead of requeueing it (the requeue would bypass admission).
`intake.ts` handles fan-out, context-only subscriptions, and the human follow-up
bypass. `tickets.ts` owns `subscribe`/`hide` and `Engine.subscribe`.

## M6 — memory

`recall.ts` stores large bodies as spill and returns an inline summary plus a
separate `refs` list. `graph.ts` gives every context object a stable `kind:id`
handle and builds one-hop ref lists for Trigger, Thread, Ticket, Decision,
Session, Channel, and Actor. Spill rows persist those refs (`spills.refs`,
schema v4). Router/Worker task lines carry `refs=`; the trigger text itself
stays clean for user-facing acknowledgements.

`long-term.ts` persists:

- one entry per finished ticket (`ltm_<ticketId>`): title, brief, and last
  report, plus ticket/thread/trigger/channel refs;
- one entry per Router Decision (`ltm_decision_<decisionId>`): kind, thread,
  reason, trigger ids, and refs. Accept/ignore/stop/unavailable all count, so
  "plan A here, plan B there" survives across Tickets and channels.

Both are `tier=hot`. On every terminal path, `remember(ticket)` upserts the
ticket entry and grants that ticket access to its spill. Text is redacted
before it reaches the spill, including `put()` callers. The next ticket
queries by title (three most recent hits), receives a spill grant for each
hit, and gets `memory=<id> spillId=<id> refs=<handles> text=<summary>` lines
in the Worker task. The Router prompt and the main-agent assessment receive
`recentDecisions()` (the global sequence point) plus
`forThreads(ticket.threadKeys)`, so a same-Thread decision is visible without a
lexical title match and a cross-channel decision can steer a new Ticket.

The Router is a resident Session, not a per-Ticket artifact. `Runtime.start()`
arms every Router shard; each shard keeps one `sessions` row and one journal.
Admitted/filtered Triggers, Decisions, Ticket created/ended events, and
assessment outcomes are appended as redacted, bounded `observe.*`/`assessment`
entries. Router turns and assessment are serialized on that shard's session
chain, and assessment receives the last 12 entries as `routerSession`. The
entries carry no model role, so replay does not treat a journal event as a user
turn.

Recall requires the reader ticket id; an `ltm` id alone is not a capability.
`read_object` accepts a spill id or a `kind:id` handle. Every hop re-checks
the reader ticket: a trigger/thread/ticket/decision is readable only when the
reader owns or shares its Thread; a session only when it is the caller's own
session. A handle is a pointer, never a grant.

Recall is lexical-first and deterministic (ADR-010, implemented in
`src/memory/long-term.ts`). `query()`:

- Normalizes query and body tokens with NFKC, lower-casing, and
  punctuation/whitespace collapse, maps them through a small explicit in-repo
  synonym/morphology table, and removes stop words from queries. There is no
  model, provider, learned vocabulary, or new dependency.
- Treats any query token found in a readable spill body or in an entry's tags
  as a direct candidate, so tag-only queries retrieve. Requested `tags` remain
  an exact AND filter (trimmed, case-sensitive) and are never relaxed.
- Builds a per-query tag index over the same retention-bounded entry set and
  expands exactly one hop from direct candidates across shared tags; entries
  reached by the hop do not seed another hop. `remember()` already stores
  ticket thread keys as tags, so those existing links participate in the same
  hop without a new link table. Entries without a readable spill are never
  eligible.
- Orders by `tagHits` desc, then `textHits` desc (each query token capped at
  5), then `hopScore` desc, then hot before cold, then `createdAt` desc, then
  `id` desc. There is no randomness, provider call, or wall-clock-dependent
  ranking.

Retention is two-tier. Hot ticket/decision entries default to 1000 entries /
90 days (`DS_AGENT_MEMORY_MAX_ENTRIES`, `DS_AGENT_MEMORY_MAX_AGE_DAYS`).
Before a hot entry is pruned, its summary is folded into a cold Thread digest
(`ltm_digest_<thread>`), which defaults to 200 entries / 3650 days
(`DS_AGENT_MEMORY_COLD_MAX_ENTRIES`, `DS_AGENT_MEMORY_COLD_MAX_AGE_DAYS`).
`query({ tier: 'cold' })` searches only digests. Both prune passes run inside
the same transaction as the write; `forget()` deletes the entry, its spill,
and its grants.

Security and storage: `query()` throws without a reader ticket id; every
ranked hit, including an expanded one, grants that ticket access to the exact
spill; an `ltm` id alone is never a capability; redaction still runs before
storage; and there is no lookup-by-id API. Object handles follow the same
rule: `readObjectFor` re-checks the reader ticket's Thread on every hop.

Evidence: `test/memory-recall-eval.test.ts` measures the shipped `query()` on
the original 11 ADR-010 queries (macro recall@3 11/11 = 1.000; exact 2/2, word
order 2/2, paraphrase 3/3, tag-only 2/2, multi-hop 2/2), 15 additional
held-out-style queries authored in the same follow-up PR (regression coverage,
not independent generalization evidence), and four negative controls (0
results). It also checks deterministic
ids across repeated runs and a reopened store and a 1000-entry fixture bounded
to one body read per entry. ADR-010 records the pre-implementation baseline of
4/11 = 0.364. Embeddings are **not implemented**: any future semantic index
must sit behind an `EmbeddingPort` with a deterministic offline mock and no
provider call in CI.

## M7 — speculate

`speculate/silent.ts` creates silent Assignments; `gate.ts` decides deliver or
discard with a clause-local verdict. A discarded ticket ends without outbox;
a delivered one clears `speculative` and emits `speculate.delivered`.

## M8 — channels

`norms.ts` enforces channel formatting; `cli.ts`, `feishu.ts`,
`github-source.ts`, and `outbox-adapter.ts` are the real adapters. `a2a.ts` and
`a2a-transport.ts` are the inter-instance channel:

- `feishu.ts` maps an inbound message to a Trigger and sets
  `channel.address.group` to `message.chat_id` (alongside `chat_id`), so
  `DS_AGENT_GROUP_ALLOWLIST=<chat id>` admits that chat. Other adapters must
  populate `address.group` themselves to opt into group admission; `meta` is
  never read.

- `outbox-adapter.ts` drains the durable outbox. Transient send errors retry
  with exponential backoff up to 5 attempts; a `PermanentDeliveryError` (for
  example, an iMessage group row with no `chatGuid`) marks the row `failed` on
  the first attempt with no retry scheduled. Both terminal paths leave the
  reply `pending`; only a successful send marks it `sent`.
- `A2ARouter` validates non-empty `from`/`to`, serializable bodies, and a 64 KiB
  UTF-8 byte cap. `send` copies only `{ from, to, body }`, assigns a fresh
  `id`/`at`, drops caller-supplied `id`/`at` and unknown fields, and persists
  the normalized envelope. `route` remains the trusted local path.
- Delivery status is `delivered | unroutable | failed`.
- `a2a-transport.ts` exports the `A2ATransport` contract: `send(envelope)` may
  return an `A2ADelivery` or a promise of one, and an optional
  `receive(listener)` supplies inbound envelopes. A transport moves bytes only;
  it does not validate, persist, admit, or mint identity.
- `LocalA2ATransport` is the in-repo reference implementation and test double.
  It wraps `A2ARouter.send`, so it inherits validation, the 64 KiB UTF-8 byte
  cap, persistence, and delivery statuses. It is not an authentication boundary.
- The Runtime registers its instance id as a local recipient. An envelope body
  `{ text, thread? }` (or a plain string) becomes a normal `a2a` source Trigger;
  it still passes the ingress filter and cannot self-admit. `human` is always
  false here: the in-repo A2A ingress always produces a non-human Trigger.
  Attributing a human identity through this contract is not supported, and an
  adapter must not do it by bypassing ingress through `runtime.ingest` either.
  Peer authentication is external and fail-closed.
- `runtime.sendA2A(to, body)` is the outbound API. Cross-process delivery uses
  the same envelope over an external `A2ATransport` implementation; network I/O
  and peer authentication (mTLS, signed envelopes, bearer tokens, etc.) are
  external. This repo ships no network transport and no peer authentication, so
  an adapter must add both and hand inbound bytes back through `A2ARouter.send`
  (which normalizes identity/timestamps and drops unknown fields). Do not expose
  the local endpoint over an unauthenticated wire. `test/a2a-transport.test.ts`
  covers the contract, delivery outcomes, validation/cap, persistence, and the
  non-human boundary.

## M9 — env

`local-env.ts` confines work to `<stateDir>/workspaces`, caps output, and kills
the process group on timeout. `local-agents.ts` exposes an opt-in,
owner-configured list of local specialist CLIs (`local-agents.json` or
`DS_AGENT_LOCAL_AGENTS`); a Worker can only name an id and pass a task, and the
runner uses `spawn(command, argv)` with `shell: false`, the Worker workspace as
cwd, a timeout, an output cap, and an allowlisted environment. `skills.ts` reads
owner playbooks from `skills/<id>/SKILL.md`: regular files only (symlinks are
skipped), a 2000-character prompt index, a 16000-character body cap, and a
`read_skill` tool that is documentation, not a capability. `sanitize.ts`
keeps credential values out of tool output and prompts. `vault.ts` exposes
FileVault names only. `seccomp.ts` wraps every worker bash: `sandbox-exec` on
macOS, `bwrap` on Linux; a missing wrapper is a hard error, never a plain-bash
fallback. `DS_AGENT_SANDBOX` no longer changes the policy. The wrapper confines
writes and network (denied unless the policy allows it), but not reads: macOS
allows broad `file-read*` and Linux uses `--ro-bind / /`, so the host read
boundary (including the SQLite DB) remains external and needs a container or
default-deny profile. The bash wrapper does not sandbox an arbitrary local
specialist CLI; that agent's own permission policy is part of the owner's trust
decision (see `docs/LOCAL_AGENTS.md`).

## M10 — watchdog

`watchdog.ts` runs the timer, detects stalled assignments, repeated job
failures, and marker-based goal drift (a running report that says it left the
ticket scope), and emits nudge/fail actions. `health.ts` is the offline probe.
`rules.ts` + `rules.json` hold the NL-maintainable rules.

## M11 — CLI and demo

`src/cli/main.ts` exposes `init`, `tasks`, `status`, `health`, `channels check`,
`serve`, `chat`, `emit`, `metrics`, `memory`, `a2a`, `pause`, `intervene`,
`resume`, `collab`, `team`, `teams`, `agents`, `skills`, `prompt`, `ui`, `backup`, and `restore`. `src/cli/demos/run.ts` drives the
acceptance scenarios against the
real GitHub/Feishu channels and a live model; `src/cli/demo.ts` is the offline
fixture baseline used by `demo:local`. `src/cli/bakeoff.ts` compares the
dual-layer path with `RuntimeOptions.singleSession`. `serve` runs the daemon
timer over persisted state and fixes its model at startup. By default it has no
inbound channel loop; `--imessage` (via `channel-loop.ts`) and/or `--feishu`
(via `cli/feishu.ts`) opt into one inbound poll loop per configured channel,
with independent abort controllers, durable cursors, and Outboxes over the same
Runtime/SQLite store, and the same abort → await both loops → close iMessage →
`Runtime.finish()` shutdown ordering. Both flags may be combined; both configs
are resolved and validated before `Runtime.create`, and a loop failure is
logged without stopping the other loop or daemon. `cli/channels.ts` owns that
startup plus `channels check`, the no-model/no-send preflight. `--feishu` stores
`feishu_cursor/cursor = { chatId, lastCreateTimeMs }` and seeds from `--since`,
the stored value, or FeishuSource's now-5min default; it polls one chat and
does not run a webhook or long-connection listener.

`ds-agent memory [--limit N]` prints persisted long-term memories;
`ds-agent a2a [--limit N]` prints persisted A2A envelopes. Both are offline
reads over SQLite.

The read-only local UI is a self-contained module: `src/ui/server.ts`
(`buildSnapshot`, `startUiServer`, required token auth, loopback bind,
Host/method guards, SSE), `src/ui/render.ts` (server-rendered HTML and escaping),
and `src/cli/ui.ts` (`runUi`, `registerUi`). It reads visible tickets, threads,
outbox metadata for visible tickets (never message bodies), health, metrics, and
whitelisted lifecycle-event fields without a Session, model, or daemon.
`ds-agent ui` is wired through `main.ts` and stays fail-closed: it needs
`DS_AGENT_UI_TOKEN` or `--token` (at least 16 characters) and binds loopback
only; see `docs/UI.md` for the endpoints and security model.

`ds-agent backup --out <file.db>` and `ds-agent restore <file.db> [--force]`
call `src/cli/backup.ts` over `src/store/backup.ts`: backup is a WAL-safe
`VACUUM INTO` snapshot, and restore refuses to replace an existing store
without `--force`, keeping the old database and WAL sidecars under
`<state-dir>/backups/pre-restore-<timestamp>.db*`.

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
`[redacted]` tool output, FileVault names only, default-on fail-closed OS
sandbox, spill ACL, and untrusted `meta` rejection. Managed credentials and
host-level seccomp stay external as PLAN §9 says.

## Tests

```text
npx vitest run test/runtime-integration.test.ts   8 tests: shards, mesh, memory, lifecycle, A2A, bake-off
npx vitest run test/router-shards.test.ts          route/priority/filter contracts
npx vitest run test/worker-mesh.test.ts            capacity/least-loaded/release
npx vitest run test/long-term-memory.test.ts       persistence, normalization, tag/hop recall, ACL, redaction
npx vitest run test/memory-graph.test.ts           refs persistence, trigger→thread→ticket hops, decision memory, cold digest
npx vitest run test/memory-recall-eval.test.ts     offline recall@3, held-out, determinism, 1000-entry bound
npx vitest run test/lifecycle-a2a.test.ts          lifecycle bus + envelope delivery
npx vitest run test/runtime-wiring.test.ts         default-path service construction
npx vitest run test/cli-memory-a2a.test.ts         offline operator views
npx vitest run test/metrics-curve.test.ts          percentiles + bake-off math
pnpm typecheck                                     pass
pnpm lint                                          pass
pnpm format:check                                  pass
pnpm test:coverage                                 451 passed, 54 files; statements/lines 82.39%, branches 80.93%, functions 90.11% (no threshold)
offline CI (DS_AGENT_ALLOW_MOCK_FIXTURE=1)         452 passed, 15 skipped, 467 tests in 58 files (55 active, 3 fully skipped)
pnpm test:live (local Magpie, 2026-11-03)          22 passed, 3 files (195.34 s)
pnpm test (live Magpie, `bb11c96` + fixes)         384 passed, 3 skipped, 55 files (622.33 s)
```

The service contract suite is deterministic and offline; none of it needs a
model key. The live run above used the local Magpie gateway at
`http://127.0.0.1:3425/v1` with `auto/deepseek-v4.1-flash`; its 3 skips are
`test/demos-real-channels.test.ts`, which needs `gh auth` and real channel peers.

Live reference run (Magpie, 45 s deadline per mode):

```text
pnpm bench:bakeoff                               dual 10 / single 7 model calls
                                                 wall 34.5 s vs 24.9 s (1.39x)
                                                 verdict: dual paid 3 extra calls for Router sequencing
```
