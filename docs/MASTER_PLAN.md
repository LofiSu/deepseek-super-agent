# Master engineering plan

> Status: living coordination document · Owner: LofiSu · Created: 2026-11-03
> Baseline: `main` at `cb32a17` (`chore: add super agent orchestration configuration (#78)`)
> Authority: `PLAN.md` is the architectural contract. `docs/ROADMAP.md` is the
> living evidence/priority board. This document coordinates the next execution
> cycles; it does not replace either.

## 0. Verified baseline (2026-11-03)

All evidence below was produced on this machine against `cb32a17` in a detached
worktree at `origin/main`:

```text
pnpm typecheck                                         exit 0
pnpm lint                                              lint ok (217 tracked files)
pnpm format:check                                      exit 0
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run   372 passed, 15 skipped (387)
                                                      55 files: 52 with passing tests,
                                                      3 fully skipped
pnpm test:coverage                                     371 passed; statements 80.68%,
                                                       branches 79.67%, functions 89.72%
```

The 3 fully skipped files are `test/demos-real-channels.test.ts`,
`test/live-e2e.test.ts`, and `test/team-live.test.ts`;
`test/live-demo.test.ts` runs one offline test and skips three live ones. The
earlier `bb11c96` branch figure was 79.69%; `#78` touched no `src/` file, so the
0.02-point difference is V8 run-to-run variance. The current figures above are
the ones used by this plan.

Repository facts:

- `#78` established the orchestration contract: the main session is the only
  orchestrator; at most 3 implementation agents run while the pipeline is being
  validated; at most 4 development cycles complete per session; subagents never
  merge and never write `.super-agent/state.json`.
- Open PRs at this checkpoint: **#74** (`docs: record the final 2026-11-03 audit
  on main`), docs-only, `MERGEABLE`, `BEHIND`, stale `fa974ca` base; **#75**
  (this project-state docs PR); **#76** (`agent/gateway-hardening`, CI green,
  independent review APPROVE); **#77** (`agent/imessage-admission`, CI green,
  review in progress).
- Branch protection: required check `typecheck and test`, strict, admins
  enforced, conversation resolution required.
- GitHub Issues are disabled, so work items live in this plan and the roadmap.
- `#64` added 4,390 lines across 46 files (iMessage channel, local gateway, CLI
  wiring, 12 test files) after the last roadmap audit.

## 1. Current gap assessment

| ID | Priority | Gap | Evidence | Status |
|----|----------|-----|----------|--------|
| IMESSAGE-ADMISSION | P0 | iMessage marks every message `addressed: direct`; the default run supplies no admission rules, so the fast path admits every sender. `--handle` / `DS_AGENT_IMESSAGE_HANDLE` is optional and group chats are not detected. A message joined to multiple chats can still be misclassified as 1:1. | `src/channels/imessage.ts:110-132`; `src/ingress/filter.ts:36-58`; `docs/IMESSAGE.md` | PR #77 open, CI green, review REQUEST_CHANGES |
| P1-3 | P1 | Worker-mesh capacity is advisory: when `pickNode` returns `undefined`, the Worker still runs (`[mesh] ... capacity-full`). No queue, rejection, or backpressure. The Harness also writes `Assignment.node` directly to the ticket aggregate. | `src/harness/loop.ts:84-89,134-135`; `test/worker-mesh.test.ts` | implementing |
| P1-6 | P1 | An in-flight turn is not reconstructed after a restart; unfinished assignments are left `running` until the watchdog. | `src/cli/main.ts` serve comment; `docs/MODULES.md:60`; `docs/ROADMAP.md` P1-6 | blocked on P1-3 |
| GATEWAY-HARDENING | P1 | Gateway auth uses a non-constant-time string compare; empty token accepted; non-loopback bind unwarned; reused token file not re-chmodded. | `src/gateway/server.ts`; `src/gateway/token.ts`; `src/cli/gateway.ts` | PR #76 open, CI green, APPROVE with non-blocking follow-ups |
| GATEWAY-TOKEN-SYMLINK | P1 | Token file reads/chmods follow symlinks; a writable `DS_AGENT_HOME` can redirect the credential. Fail-closed, SSE, and identical-401 tests are missing. | Review of PR #76; `src/gateway/token.ts:25-63` | follow-up, not yet dispatched |
| GATEWAY-REVIEW | P2 | `#64` gateway/iMessage code had no independent review record and coverage is below the pre-#64 baseline (80.68% vs 82.40% lines). | `docs/ROADMAP.md`; coverage run above | #76 reviewed; #77 in progress |
| AUDIT-REFRESH | P2 | `docs/final-audit` (#74) is stale against `cb32a17`; the roadmap audit does not include `#64` or `#78`. | PR #74; `git merge-base` = `fa974ca` | Cycle 2, after P1-3 docs edits |
| SERVE-CHANNEL-LOOP | P1 | `serve` starts no inbound channel loop, so external triggers are not consumed by the long-running process. This is documented, but it limits the daemon's production usefulness. | `src/cli/main.ts:206-221`; `docs/ROADMAP.md` | bounded design decision |

## 2. Workstream ordering

```text
Cycle 1 (parallel, disjoint files; max 3 implementation agents)
  IMESSAGE-ADMISSION  iMessage fail-closed admission + group handling
  P1-3  Worker-mesh capacity/backpressure + Engine-owned node placement
  GATEWAY-HARDENING   Gateway auth/exposure hardening
  (project-state docs PR #75 is coordination work, not a fourth task)

Cycle 2 (after Cycle 1 integration; touches harness/runtime and shared docs)
  P1-6  Restart recovery for interrupted assignments/jobs
  GATEWAY-TOKEN-SYMLINK  Reject symlink/non-regular token files; add
                         fail-closed, SSE, and identical-401 tests
  AUDIT-REFRESH  Rebase PR #74 on current main and update ROADMAP/MODULES

Cycle 3
  SERVE-CHANNEL-LOOP Channel loop for serve (reuse Feishu/iMessage sources)
  Evaluate semantic long-term memory (roadmap open item)
```

Do not start P1-6 before P1-3 is merged: both change `Harness.launch`,
`Harness.drain`, and `Runtime` release hooks. Do not start AUDIT-REFRESH before
P1-3 merges: both edit `docs/MODULES.md` and `docs/ROADMAP.md`. Its earlier
placement in Cycle 1 was a planning error.

## 3. Global constraints for every task

1. Engine remains the owner of domain aggregate transitions. The only known
   direct-write deviation is `Harness.launch` setting `Assignment.node` through
   `store.putDoc('ticket', ...)` at `src/harness/loop.ts:134-135`; P1-3 removes
   it. No new direct writes are allowed. The Harness may read `Ticket` and call
   host callbacks.
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
11. Subagents never merge their own PR, never edit `.super-agent/state.json`,
    and never write this plan. Only the main orchestrator integrates.

## Task 1: IMESSAGE-ADMISSION — iMessage fail-closed admission and group handling

**Owner:** implementation agent · **Branch:** `agent/imessage-admission`
**PR:** #77 · **Depends on:** none · **Files:** `src/channels/imessage.ts`,
`src/cli/imessage.ts`, `test/channels-imessage.test.ts`, `docs/IMESSAGE.md`

### Problem

`imessageTrigger()` always sets `addressed: 'direct'`. `admissionDeny` runs
first, but with no admission rules configured it denies nothing, so the fast
path admits every message through `mention-or-direct`. `--handle` /
`DS_AGENT_IMESSAGE_HANDLE` is optional and no group metadata is read. Any party
who can message the agent's Apple ID can trigger work.

### Required behavior

1. **Default deny.** `ds-agent imessage` must refuse to start when neither a
   sender allowlist nor an explicit opt-out is configured. A sender allowlist is
   `--handle <id>`, a non-empty `DS_AGENT_IMESSAGE_HANDLE`, or a non-empty
   `DS_AGENT_ACTOR_ALLOWLIST`.
2. **Explicit opt-out.** Add `--allow-any` (and
   `DS_AGENT_IMESSAGE_ALLOW_ANY=1`) for intentional open use. Log a prominent
   warning when active.
3. **Group chats are closed by default.** Read the chat style/room metadata from
   `chat.db` (`chat.style`, `chat.room_name`) and mark/group messages. Aggregate
   groupness across **all** `chat_message_join` rows for a message before guid
   dedupe: any style 43 or non-empty `room_name` makes the message a group, and
   the group chat id is retained in `channel.address.group`. Missing or
   ambiguous chat metadata is treated as group/unknown and skipped, never as
   1:1. Do not turn group messages into `addressed: 'direct'` triggers. Skip
   them by default; add `--allow-groups` / `DS_AGENT_IMESSAGE_ALLOW_GROUPS=1` as
   an explicit opt-in. Do not rely on text content to detect a group.
4. **Addressing.** Only a 1:1 message from the allowlisted sender is
   `addressed: 'direct'`. A group message that is explicitly allowed must not be
   `direct`; leave `addressed` unset so it still passes normal admission.
5. **Handle normalization.** Trim `--handle` / `DS_AGENT_IMESSAGE_HANDLE` once
   and use the same value for the admission gate and the SQL filter. Reject a
   missing or flag-like value instead of silently idling.
6. **Schema compatibility.** If `chat.style` / `chat.room_name` are absent, fail
   once with a clear compatibility error; do not retry forever and do not fall
   back to treating rows as 1:1.
7. **No silent fallback.** The CLI error must name the missing flag/env and the
   safe example: `--handle "+..."`.
8. **Docs.** Update `docs/IMESSAGE.md` environment table and limitations with
   the new defaults and opt-outs.

### Tests

- `ImessageSource.pull` skips group messages when groups are closed; includes
  them when opened.
- A message joined to both a 1:1 chat and a group chat is classified as a
  group; a message with no chat row is classified as unknown/group.
- A style-43 group with `NULL` room_name is a group at the DB level.
- `imessageTrigger` sets `addressed: 'direct'` only for 1:1 messages, and sets
  `channel.address.group` for group messages.
- A pure exported admission-decision helper returns the refusal message when no
  sender allowlist and no `--allow-any`; whitespace/comma-only values refuse.
- Existing iMessage tests stay green.

### Acceptance

- Default invocation without `--handle`, `DS_AGENT_IMESSAGE_HANDLE`, or
  `DS_AGENT_ACTOR_ALLOWLIST` exits with a clear error before opening the
  database.
- Default invocation never ingests a group-chat message.
- All new tests and the offline suite pass.

## Task 2: P1-3 — Worker-mesh capacity enforcement and backpressure

**Owner:** implementation agent · **Branch:** `agent/P1-3-mesh-backpressure`
**Depends on:** none · **Files:** `src/harness/loop.ts`, `src/harness/mesh.ts`,
`src/core/host.ts`, `src/core/assignments.ts`, `src/runtime.ts`,
`src/metrics/metrics.ts`, `test/worker-mesh.test.ts`,
`test/runtime-integration.test.ts`, `docs/MODULES.md`, `docs/ROADMAP.md`

### Problem

`Harness.launch` calls `pickNode`; when no node has capacity it logs
`node=none capacity-full` and runs the Worker anyway. Capacity is therefore
advisory, and parallel workers can exceed `DS_AGENT_MESH_CAPACITY`. The same
method also writes the ticket aggregate directly to persist `Assignment.node`.

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
8. Route assignment-node placement through the Engine: replace the direct
   `store.putDoc('ticket', ...)` with an Engine-owned placement callback. Add a
   regression test proving the Harness does not write the ticket aggregate.
9. Update `docs/MODULES.md` M1 and the P1-3 roadmap row from "advisory" to
   "enforced in-process with a bounded queue".

### Tests

- Capacity 1: launch two tickets; the second Worker does not start while the
  first is running; it starts after the first ends.
- FIFO order across three queued tickets.
- A ticket that ends/pauses while queued is skipped.
- A full queue rejects without throwing and does not run the Worker.
- `drain()` resolves with queued work and does not hang.
- Ordinary settle does **not** drain or abandon queued work; only shutdown does.
- Node placement goes through the Engine and the Harness performs no direct
  ticket write.
- Existing mesh and runtime integration tests stay green.

### Acceptance

- No Worker turn starts when every node is at capacity.
- In-flight count never exceeds the configured capacity.
- Shutdown is bounded and does not leave a pending promise.
- No Harness path writes a ticket aggregate directly.

## Task 3: GATEWAY-HARDENING — Gateway security hardening

**Owner:** implementation agent · **Branch:** `agent/gateway-hardening`
**PR:** #76 · **Depends on:** none · **Files:** `src/gateway/server.ts`,
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

### Non-blocking follow-up (GATEWAY-TOKEN-SYMLINK, Cycle 2)

The merged hardening rejects chmod failure but still follows symlinks. The
follow-up must `lstat` the token path, reject symlinks and non-regular files,
read with `O_NOFOLLOW`, create atomically, and add tests for fail-closed chmod,
SSE headers, and identical 401 bodies across malformed/wrong/missing tokens.

### Acceptance

- Wrong or missing token returns 401 and never reaches an upstream.
- A token file with mode 0644 is corrected to 0600 before use.
- Starting on `0.0.0.0` prints an explicit exposure warning.
- Offline suite and docs are consistent.

## Task 4: AUDIT-REFRESH — Refresh the final audit for `cb32a17`

**Owner:** chief engineer · **Branch:** `docs/final-audit` (PR #74)
**Depends on:** Task 2 merged · **Files:** `docs/ROADMAP.md`, `docs/MODULES.md`

Rebase PR #74 on current `main`, replace the stale `fa974ca` evidence with the
verified `cb32a17` baseline above, add revision-history rows for `#64` and
`#78`, and state that the audit covers the iMessage/gateway surface. Do not
claim a live Magpie run. This task follows P1-3 because both edit
`docs/ROADMAP.md` and `docs/MODULES.md`.

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

Review the `#64` diff and the new workstream PRs against the architecture
constraints. Record findings with file:line and severity. Add focused tests for
any uncovered gateway/iMessage branch that the implementation agents did not
cover. Do not chase a percentage target; cover security-relevant branches first.
PR #76 has been reviewed; PR #77 is in progress.

## 4. Definition of done for a cycle

- Every task PR has an independent review with a verdict.
- Required CI is green on the exact head SHA.
- No unresolved review conversation.
- Master plan, development status, agent registry, and PR review log updated.
- A regression run on `main` after merge.
- `.super-agent/state.json` reflects the checkpoint; only the main orchestrator
  writes it.
