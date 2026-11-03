# Master engineering plan

> Status: living coordination document · Owner: LofiSu · Created: 2026-11-03
> Baseline: `main` at `bb11c96` (`feat: iMessage channel + local OpenAI-compatible gateway (#64)`)
> Authority: `PLAN.md` is the architectural contract. `docs/ROADMAP.md` is the
> living evidence/priority board. This document coordinates the next execution
> cycles; it does not replace either.

## 0. Verified baseline (2026-11-03)

All evidence below was produced on this machine against `bb11c96`:

```text
pnpm typecheck                                         exit 0
pnpm lint                                              lint ok (208 tracked files)
pnpm format:check                                      exit 0
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run   372 passed, 15 skipped, 52 files
pnpm test:coverage                                     371 passed; statements 80.68%,
                                                       branches 79.69%, functions 89.72%
```

Repository facts:

- Open PR: **#74** (`docs: record the final 2026-11-03 audit on main`), docs-only,
  `MERGEABLE`, `BEHIND`, CI green. Its audit base is `fa974ca`, which predates
  `#64`; its documented coverage (302 tests / 82.40%) no longer matches `main`.
- Branch protection: required check `typecheck and test`, strict, admins
  enforced, conversation resolution required.
- GitHub Issues are disabled, so work items live in this plan and the roadmap.
- `#64` added 4,390 lines across 46 files (iMessage channel, local gateway,
  CLI wiring, 13 test files) after the last roadmap audit.

## 1. Current gap assessment

| ID | Priority | Gap | Evidence | Status |
|----|----------|-----|----------|--------|
| IMESSAGE-ADMISSION | P0 | iMessage accepts any sender by default and marks every message `addressed: direct`, including group chats. `--handle` is only "strongly recommended". | `src/channels/imessage.ts` `imessageTrigger`; `src/ingress/filter.ts` admits `direct` when no admission rules are configured; `docs/IMESSAGE.md` | open |
| P1-3 | P1 | Worker-mesh capacity is advisory: when `pickNode` returns `undefined`, the Worker still runs (`[mesh] ... capacity-full`). No queue, rejection, or backpressure. | `src/harness/loop.ts:84-89`; `test/worker-mesh.test.ts` | open |
| P1-6 | P1 | An in-flight turn is not reconstructed after a restart; unfinished assignments are left `running` until the watchdog. | `src/cli/main.ts` serve comment; `docs/MODULES.md:60`; `docs/ROADMAP.md` P1-6 | open |
| GATEWAY-HARDENING | P1 | Gateway auth uses a non-constant-time string compare; `/`, `/ui`, and `/health` are unauthenticated; non-loopback bind is unwarned; a reused token file is not re-chmodded. | `src/gateway/server.ts`; `src/gateway/token.ts`; `src/cli/gateway.ts` | open |
| GATEWAY-REVIEW | P2 | `#64` review is recorded in `docs/PR_REVIEW_LOG.md`; remaining work is admission/auth hardening plus focused coverage (80.68% vs the historical 82.40% baseline). | `docs/PR_REVIEW_LOG.md`; `docs/ROADMAP.md` | open |
| AUDIT-REFRESH | P2 | `docs/final-audit` (#74) is stale against `bb11c96`; the audit table does not include `#64`. | PR #74; `git merge-base` = `fa974ca` | open |
| SERVE-CHANNEL-LOOP | P1 | `serve` starts no inbound channel loop, so external triggers are not consumed by the long-running process. This is documented, but it limits the daemon's production usefulness. | `src/cli/main.ts:206-221`; `docs/ROADMAP.md` | bounded design decision |

## 2. Workstream ordering

```text
Cycle 1 (parallel, disjoint files)
  IMESSAGE-ADMISSION  iMessage fail-closed admission + group handling
  P1-3  Worker-mesh capacity/backpressure
  GATEWAY-HARDENING Gateway auth/hardening

Cycle 2 (after P1-3 merges; touches harness/runtime and its docs)
  P1-6  Restart recovery for interrupted assignments/jobs
  AUDIT-REFRESH Refresh PR #74 audit evidence (after P1-3's MODULES/ROADMAP edits)
  GATEWAY-REVIEW  Coverage + independent review of #64 surface

Cycle 3
  SERVE-CHANNEL-LOOP Channel loop for serve (reuse Feishu/iMessage sources)
  Evaluate semantic long-term memory (roadmap open item)
```

Do not start P1-6 before P1-3 is merged: both change `Harness.launch`,
`Harness.drain`, and `Runtime` release hooks.

## 3. Global constraints for every task

1. Engine remains the only writer of domain aggregates. The Harness must not
   invent domain state; it may only read `Ticket` and call host callbacks.
2. Harness must not acquire domain business rules. Worker must not reply to
   external channels or make Router decisions.
3. Store is the source of truth. Any in-process queue must be recoverable or
   explicitly documented as process-local.
4. Untrusted trigger metadata never grants authorization. Admission is not
   authentication.
5. Credentials never appear in prompts, tool results, journals, logs, or tests.
6. Sandbox boundaries stay fail-closed.
7. No direct pushes to `main`. Branch: `agent/<task-id>-<description>`. PR title:
   `[SUPER-AGENT][TASK-ID] ...`.
8. Every PR runs `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and the
   offline suite with `CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1`.
9. Do not run live model tests or real-channel demos unless credentials and
   explicit authorization are present.
10. Do not change `src/shared/types.ts` or `src/shared/ports.ts` without an
    architecture decision recorded in `docs/ARCHITECTURE_DECISIONS.md`.

## Task 1: IMESSAGE-ADMISSION — iMessage fail-closed admission and group handling

**Owner:** implementation agent · **Branch:** `agent/imessage-admission`
**Depends on:** none · **Files:** `src/channels/imessage.ts`,
`src/cli/imessage.ts`, `test/channels-imessage.test.ts`, `docs/IMESSAGE.md`

### Problem

`imessageTrigger()` always sets `addressed: 'direct'`. Admission rules are
optional: with none configured, the fast path accepts `direct` without any
admission, mention, or noise check. `--handle` is optional, so a default run
ingests messages from any sender in any chat, including group chats. Any party
who can message the agent's Apple ID can trigger work.

### Required behavior

1. **Default deny.** `ds-agent imessage` must refuse to start when neither a
   sender allowlist nor an explicit opt-out is configured. A sender allowlist is
   either `--handle <id>` or a non-empty `DS_AGENT_ACTOR_ALLOWLIST`.
2. **Explicit opt-out.** Add `--allow-any` (and
   `DS_AGENT_IMESSAGE_ALLOW_ANY=1`) for intentional open use. Log a prominent
   warning when active.
3. **Group chats are closed by default.** Read the chat style/room metadata from
   `chat.db` (`chat.style`, `chat.room_name`) and mark/group messages. Do not
   turn group messages into `addressed: 'direct'` triggers. Skip them by default;
   add `--allow-groups` / `DS_AGENT_IMESSAGE_ALLOW_GROUPS=1` as an explicit
   opt-in. Do not rely on text content to detect a group.
4. **Addressing.** Only a 1:1 message from the allowlisted sender is
   `addressed: 'direct'`. A group message that is explicitly allowed must not be
   `direct`; leave `addressed` unset so it still passes normal admission.
5. **No silent fallback.** The CLI error must name the missing flag/env and the
   safe example: `--handle "+..."`.
6. **Docs.** Update `docs/IMESSAGE.md` environment table and limitations with
   the new defaults and opt-outs.

### Tests

- `ImessageSource.pull` skips group messages when groups are closed; includes
  them when opened.
- `imessageTrigger` sets `addressed: 'direct'` only for 1:1 messages.
- A pure exported admission-decision helper returns the refusal message when no
  sender allowlist and no `--allow-any`.
- Existing iMessage tests stay green.

### Acceptance

- Default invocation without `--handle` or `DS_AGENT_ACTOR_ALLOWLIST` exits with
  a clear error before opening the database.
- Default invocation never ingests a group-chat message.
- All new tests and the offline suite pass.

## Task 2: P1-3 — Worker-mesh capacity enforcement and backpressure

**Owner:** implementation agent · **Branch:** `agent/P1-3-mesh-backpressure`
**Depends on:** none · **Files:** `src/harness/loop.ts`, `src/harness/mesh.ts`,
`src/runtime.ts`, `test/worker-mesh.test.ts`, `test/runtime-integration.test.ts`,
`docs/MODULES.md`, `docs/ROADMAP.md`

### Problem

`Harness.launch` calls `pickNode`; when no node has capacity it logs
`node=none capacity-full` and runs the Worker anyway. Capacity is therefore
advisory, and parallel workers can exceed `DS_AGENT_MESH_CAPACITY`.

### Required behavior

1. When `pickNode` returns `undefined` after the Router sequence, do **not**
   start the Worker. Enqueue the ticket in a FIFO pending-worker queue.
2. Pump the queue when a Worker is released (`Runtime.onTicketEnded` calls
   `harness.release(ticketId)` after `workerMesh.release`). A dequeued ticket
   must be re-read from the Store; skip it if missing, ended, or paused.
3. Bound the queue. Add `DS_AGENT_MESH_QUEUE` (default 100). If the queue is
   full, do not run the Worker; log `mesh.queue-full`, increment
   `mesh.queue_rejected`, and resolve the launch promise without throwing
   (the ticket stays open for a later retry).
4. Preserve the launch promise contract: `Harness.launch` resolves only when the
   ticket's Worker turn completes, or when it is rejected from a full queue.
5. `Harness.drain()` must not hang on queued work. On drain, clear the queue,
   log `mesh.queue_drained count=N`, and resolve queued promises; the tickets
   remain open in the Store.
6. Keep `WorkerMeshRegistry` as pure capacity accounting. The queue belongs to
   `Harness` (scheduler), not the registry.
7. Metrics: `mesh.queued`, `mesh.dequeued`, `mesh.queue_rejected`,
   `mesh.queue_drained`.
8. Update `docs/MODULES.md` M1 and the P1-3 roadmap row from "advisory" to
   "enforced in-process with a bounded queue".

### Tests

- Capacity 1: launch two tickets; the second Worker does not start while the
  first is running; it starts after the first ends.
- FIFO order across three queued tickets.
- A ticket that ends/pauses while queued is skipped.
- A full queue rejects without throwing and does not run the Worker.
- `drain()` resolves with queued work and does not hang.
- Existing mesh and runtime integration tests stay green.

### Acceptance

- No Worker turn starts when every node is at capacity.
- In-flight count never exceeds the configured capacity.
- Shutdown is bounded and does not leave a pending promise.

## Task 3: GATEWAY-HARDENING — Gateway security hardening

**Owner:** implementation agent · **Branch:** `agent/gateway-hardening`
**Depends on:** none · **Files:** `src/gateway/server.ts`,
`src/gateway/token.ts`, `src/cli/gateway.ts`, `src/gateway/web.ts`,
`test/gateway.test.ts`, `test/gateway-web.test.ts`, `docs/GATEWAY.md`

### Required behavior

1. Compare bearer tokens in constant time using `crypto.timingSafeEqual` after a
   length check. Reject malformed headers without distinguishing "missing" from
   "wrong" in the response body.
2. Refuse to start with an empty token.
3. Warn (do not silently expose) when `--host` is not a loopback address
   (`127.0.0.1`, `::1`, `localhost`). State that `/health` and the dashboard are
   unauthenticated in that mode.
4. Re-apply mode `0600` to an existing gateway token file on read; fail closed if
   it cannot be secured.
5. Add `Cache-Control: no-store` to authenticated responses and
   `X-Content-Type-Options: nosniff` to every response.
6. The dashboard must not embed the token; keep it read-only and limited to
   `/health` data.
7. Add tests for constant-time authorization behavior (401 for wrong/missing),
   empty-token refusal, token-file permissions, and the non-loopback warning.

### Acceptance

- Wrong or missing token returns 401 and never reaches an upstream.
- A token file with mode 0644 is corrected to 0600 before use.
- Starting on `0.0.0.0` prints an explicit exposure warning.
- Offline suite and docs are consistent.

## Task 4: AUDIT-REFRESH — Refresh the final audit for `bb11c96`

**Owner:** chief engineer · **Branch:** `docs/final-audit` (PR #74)
**Depends on:** none · **Files:** `docs/ROADMAP.md`, `docs/MODULES.md`

Rebase PR #74 on `bb11c96`, replace the stale `fa974ca` evidence with the
verified baseline above, add a revision-history row for `#64`, and state that
the audit covers the iMessage/gateway surface. Do not claim a live Magpie run.

## Task 5: P1-6 — Restart recovery for interrupted assignments

**Owner:** implementation agent · **Branch:** `agent/P1-6-restart-recovery`
**Depends on:** Task 2 (mesh) merged · **Files:** `src/runtime.ts`,
`src/core/assignments.ts`, `src/core/engine.ts`, `src/harness/loop.ts`,
`src/cli/main.ts`, `test/cli-serve.test.ts`, `test/runtime-integration.test.ts`,
`docs/MODULES.md`, `docs/ROADMAP.md`

### Required behavior

1. On `Runtime.start`, scan for open tickets whose latest assignment is
   `running` but whose session heartbeat is stale (process-restart signal).
2. End the interrupted assignment through the Engine with a
   `recovered`/`interrupted` reason and create a new pending assignment; do not
   reuse a running assignment. All writes go through the Engine.
3. Relaunch the Worker only when the model is live and the ticket is not paused.
   A MockModel start must not burn deferred work; leave a durable recovery event
   and log instead.
4. Replay the existing session journal (it already contains prior messages) and
   append a `RECOVERED` prompt naming the interrupted assignment.
5. At-least-once semantics are explicit: external side effects from the killed
   turn may repeat. Document this; do not claim exactly-once.
6. Idempotency: starting twice must not create two replacement assignments.
7. Add a test that seeds a running assignment, closes the store, creates a new
   Runtime on the same home, starts it, and observes exactly one recovery event
   and one new assignment; a second start is a no-op.

### Acceptance

- No open ticket is left permanently `running` after a restart.
- Recovery is idempotent and Engine-owned.
- Offline tests cover restart with and without a live model.

## Task 6: GATEWAY-REVIEW — Independent review and coverage of the `#64` surface

**Owner:** review lead · **Branch:** none (review only)
**Depends on:** none · **Files:** `docs/PR_REVIEW_LOG.md`

Review the `#64` diff and the four new workstream PRs against the architecture
constraints. Record findings with file:line and severity. Add focused tests for
any uncovered gateway/iMessage branch that the implementation agents did not
cover. Do not chase a percentage target; cover security-relevant branches first.

## 4. Definition of done for a cycle

- Every task PR has an independent review with a verdict.
- Required CI is green on the exact head SHA.
- No unresolved review conversation.
- Master plan, development status, agent registry, and PR review log updated.
- A regression run on `main` after merge.
