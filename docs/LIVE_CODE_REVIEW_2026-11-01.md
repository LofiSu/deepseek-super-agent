# Live code review — 2026-11-01 (Session D)

Scope: the `live-real-model` tree in this repository. The review is a full-tree pass, not a diff, because the branch is the artifact under review. `docs/REVIEW.md` (2026-10-31) is the earlier baseline; it is stale in several places and is treated here as a claim to re-check, not as evidence.

Method: [`docs/CODE_REVIEW_METHOD.md`](./CODE_REVIEW_METHOD.md). Every finding names a file and a line. A behavior that is only asserted by a log substring is marked as such. The live model was the local Magpie gateway (`workbuddy/deepseek-v4.1-flash`); the demo and the default test suite both refuse `MockModel` (`src/cli/demo.ts:33-45`, `test/fixtures.ts:11-23`).

## Verdict

**1 Critical, 5 High, 10 Medium.** The five controls the brief asked to re-check are not uniform: **#7 and #9 and #15 are fixed; #11 and #13 are partial.** The control plane is materially less hollow than `docs/REVIEW.md` describes — Eval has non-accept outcomes, the deliver gate is real, the watchdog acts, workers no longer hold the Engine, spills are paged and granted, and the journal drives the next turn. The remaining gaps are concentrated in trust of `trigger.meta`, the speculative isolation boundary, the shell process boundary, and the fact that the Router still does not assess or sequence work.

This is a review of the tree, not a merge approval. `src/core/**`, `src/env/**`, and `src/watchdog/**` are 高 paths under the method and need a person in addition to the directing author.

## The 15-point control-plane checklist

The brief refers to `#7/#9/#11/#13/#15`; the tree has no 15-row list of its own (`docs/REVIEW.md` uses `C/H/M` ids). This review numbers the checklist below so the five can be named unambiguously. The mapping is: **#7 subscription arbitration, #9 ToolContext Engine leak, #11 Gate sequence, #13 Spill ACL, #15 journal ReAct.**

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 1 | Eval can refuse (`ignore` / `stop` / `unavailable`) | **Partial** | `src/core/assessment.ts:31-41`, `src/core/evals.ts:39-57`; default is still `accept` for every text that is not a literal command |
| 2 | Router assessment is wired | **Open** | `Engine.decide` exists (`src/core/engine.ts:38-41`) but no router tool calls it; only tests do |
| 3 | Batch size can exceed one on the real ingress path | **Open** | `src/runtime.ts:202` evaluates after every ingest; demo batches are all `size=1`; bench is synthetic |
| 4 | DeliverGate is independent of the worker's boolean | **Fixed** | `src/core/assignments.ts:48`, `src/speculate/gate.ts:37-45` |
| 5 | `maySurface` blocks speculative outbound | **Fixed** | `src/core/engine.ts:64-68`, `src/core/replies.ts:18-21` |
| 6 | Watchdog mutates an assignment (nudge / fail) | **Fixed** | `src/watchdog/watchdog.ts:88-92,106-132`; residual `nudge_worker` tool is log-only |
| 7 | Subscription arbitration (one winner, human-only, mandate) | **Fixed** | `src/core/intake.ts:55-67,109-129`; `test/subscription.test.ts` |
| 8 | Credential values stay out of tool output, prompts, journal, spill | **Partial** | Env allowlist + redaction work; spill body is stored before redaction (`src/runtime.ts:182`) |
| 9 | `ToolContext` does not hand the Engine to workers | **Fixed** | `src/shared/ports.ts:49-99`, `src/core/role-ports.ts:21-52`, `src/harness/tools.ts:21-28` |
| 10 | Speculative work is rollbackable (workdir, jobs, processes) | **Partial** | Scratch workdir exists (`src/env/local-env.ts:65-81`), but isolation is a string check and jobs/processes are not rolled back |
| 11 | Gate runs before the worker, and the Router is the sequence point | **Partial** | Deterministic Eval runs before launch (`src/runtime.ts:202-207`); Router and Worker still start in `Promise.all` (`src/harness/loop.ts:70-73`) |
| 12 | Speculative discard ends the assignment and writes no reply | **Fixed** | `src/core/assignments.ts:59-69,91-105`; `test/speculate.test.ts:97-132` |
| 13 | Spill ACL + paging (an id alone is not a capability) | **Partial** | `src/memory/acl.ts:26-50` is correct for `read_object`; `meta.spillId` and the worker shell bypass it |
| 14 | `read_object` returns one page, not the whole body | **Fixed** | `src/memory/acl.ts:5,38-50`; `test/highs.test.ts:160-211` |
| 15 | Session journal drives the next ReAct turn | **Fixed** | `src/harness/loop.ts:238-247,287-300`, `src/harness/session.ts:47-66`; `test/highs.test.ts:213-267` |

Counts from the detailed sections: **1 Critical, 5 High, 10 Medium.**

## Critical

### C1. Untrusted `trigger.meta` still controls admission — and now grants spill access

**Architecture + code.** `Trigger.meta` is documented as untrusted (`src/shared/types.ts:25`). The engine's only admission port trusts a boolean on it:

```ts
// src/runtime.ts:100-106
scope: {
  admit: trigger => {
    if (trigger.meta.admitted === true) return { listened: true, reason: 'admitted' }
    const verdict = filterTrigger(trigger, model)
    ...
```

`Runtime.ingest` does not clear that field on a drop; it forwards the original trigger:

```ts
// src/runtime.ts:180-195
let incoming = trigger
if (verdict.action === 'pass') {
  ...
  const meta = { ...trigger.meta, admitted: true, strength: ..., label: ... }
  if (recall.spillId) meta.spillId = recall.spillId
  incoming = { ...trigger, text: recall.inline, meta }
}
const result = this.engine.receive(incoming)
```

On a pass, `...trigger.meta` is spread first, so a caller-supplied `spillId` survives when the text is short enough not to produce a new spill (`src/runtime.ts:186-192`). `Tickets.create` then treats that string as a capability and grants it:

```ts
// src/core/tickets.ts:24,60-61
const spillId = typeof input.primary.meta.spillId === 'string' ? input.primary.meta.spillId : undefined
...
grantTicketSpill(this.host.repo, spillId, id)
for (const row of ticket.inputs) grantTicketSpill(this.host.repo, row.spillId, id)
```

`fastPath` has the same shape for silence: `if (trigger.meta.speculate === true) return { pass: true, reason: 'speculate-tag' }` (`src/ingress/filter.ts:37`). The same field also decides `strength` (`src/core/evals.ts:153-158`), the ticket title (`src/core/tickets.ts:23`), and whether a ticket is speculative (`src/speculate/gate.ts:4-6`).

**Reproduced.**

- Noise plus `meta: { admitted: true }` through the public `Runtime.ingest`:
  - ingress line: `[ingress] two-level fast=drop:noise semantic=drop:noise ... action=drop layer=fast`
  - engine line: `[engine] Intake.receive id=trg_noise_admitted result=stored`
  - result: one ticket and one acknowledgement reply for the dropped text.
- Short trigger plus `meta: { spillId: 'spill_1' }`, where `spill_1` already contains another object:
  - `ticket.spillId = spill_1`
  - grants: `ticket:ticket_1`, `session:worker_ticket_1`
  - `read_object` now returns it to that worker.

**Why Critical.** One untrusted field defeats two boundaries at once: the ingress filter and the new spill confidentiality check. The method's §3 already calls an external payload setting `admitted` a 高; the spill grant is new in this tree and raises the combined impact. The root is pre-existing (`docs/REVIEW.md` H1); the grant path is introduced by the ACL work.

**Fix direction.** Treat `meta` as data, never as a decision. Derive admission and spill grants inside `Engine` from the trigger's stored text and the spill the engine itself created; do not copy `admitted`, `strength`, `speculate`, or `spillId` from the caller. At minimum, strip `meta.admitted`/`meta.spillId` before `Engine.receive` and require a per-ticket grant created from the engine-owned spill id.

## High

### H1. Credential values persist in spill bodies

**Code + behavior.** `Runtime.ingest` spills the raw trigger text before any redaction:

```ts
// src/runtime.ts:181-184
const recall = inlineOrSpill(trigger.text, body => this.store.putSpill(body))
```

Redaction is applied later: to shell output (`src/env/local-env.ts:111-112`), to the prompt and tool results in `runTurn` (`src/harness/loop.ts:237-283`), and to the runtime logger (`src/runtime.ts:36-44,85-87`). The spill body itself is stored untouched in SQLite (`src/store/sqlite.ts:146-150`).

Reproduced with a sentinel in `DS_AGENT_API_KEY` and a long trigger containing the same value: `store.getSpill(spillId)` contained the sentinel, while the session journal did not. This is exactly the method's security bar: values stay out of **spill bodies**. The demo's `read_object` path is not the leak (tool output is redacted); the leak is the stored body and any future `store.getSpill` caller that is not behind the redacting tool wrapper.

**Grade High.** The env allowlist and stdout redaction are real and tested (`test/sanitize.test.ts:44-130`); this is the remaining hole in the same red line.

### H2. Speculative rollback is not an isolation boundary

**Code.** Speculative workers use a scratch directory (`src/env/local-env.ts:65-81`), and `report_to_router` calls `settleSpeculation` (`src/harness/tools.ts:264-266`). The command guard is a string heuristic:

```ts
// src/env/local-env.ts:160-163
function leavesWorkdir(command: string): boolean {
  if (command.includes('..') || command.includes('~')) return true
  return /(?:^|[\s<>|;&])\//.test(command)
}
```

A slash preceded by a quote is not matched. **Reproduced:** in an isolated speculative shell, `python3 -c "open('/tmp/ds-spec-escape-...','w').write('x')"` wrote the file; `discardIsolated` did not remove it. The plain `echo hi > /tmp/...` form is rejected, which is what the unit test covers (`test/speculate.test.ts:208-210`).

Three side effects are outside the rollback:

- `start_job` is available to a speculative worker (`src/harness/tools.ts:288-294`) and is not cancelled on discard; the timer still runs and enqueues a `JOB_DONE` turn (`src/harness/loop.ts:89-117`).
- `settleSpeculation` only touches the workdir (`src/speculate/silent.ts:15-18`); it does not kill child processes.
- A watchdog tick that fails a speculative assignment calls `Engine.report` directly (`src/watchdog/watchdog.ts:123-132`) and never calls `settleSpeculation`, so the scratch directory remains.

**Grade High.** The workdir pattern is the right shape and the deliver/discard tests pass, but it is not a boundary a model cannot cross. Use an OS sandbox (the repo already has `sandbox-exec`/`bwrap` wrappers in `src/env/seccomp.ts` but `DS_AGENT_SANDBOX` is opt-in and off by default), reject commands by execution policy rather than string matching, and settle on every terminal path (`Engine.report`, watchdog fail, job stop).

### H3. Shell timeout does not release the worker turn

**Code + measurement.** `LocalEnv` passes `timeout` to `spawn` and resolves on `close`:

```ts
// src/env/local-env.ts:97-107
const child = spawn(bin, args, { cwd, timeout: this.timeoutMs, env: this.shellEnv(cwd, isolated) })
...
child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
```

`timeout` sends `SIGTERM` to the shell pid, not the process group. A grandchild that holds the inherited pipe keeps `close` pending. Measured with `timeoutMs: 300` and `bash -c 'sleep 2; echo done'`: **2010 ms elapsed**, code 1, empty stdout. `bash -c 'sleep 3600'`, or any child that outlives the shell, blocks that session's promise chain for the child's lifetime; `enqueue` will not start the next turn (`src/harness/loop.ts:163-168`). stdout and stderr are appended without a cap (`src/env/local-env.ts:104-105`).

**Grade High.** The watchdog can fail an assignment after `stuckMs`, but it cannot free the worker chain or kill the child. Use `spawn(..., { detached: true })` and kill the process group on timeout, or run under the sandbox with a hard kill; cap stdout/stderr and spill the overflow.

### H4. The Router still does not assess or sequence work

**Code.** The new deterministic gate is real:

```ts
// src/core/assessment.ts:31-41
export function assessTriggers(triggers: Trigger[], live: Ticket | undefined): Assessment {
  ...
  const command = commandOf(primary.text)
  if (command === 'unavailable') return { kind: 'unavailable', reason: 'assessor-unavailable' }
  if (command === 'stop') { ... }
  if (command === 'ignore') return { kind: 'ignore', reason: 'no-action' }
  return { kind: 'accept', reason: 'actionable' }
}
```

`commandOf` is three anchored regexes (`src/core/assessment.ts:9-11,19-25`). Any text that does not literally begin with `stop`/`cancel`/`abort`, `ignore this`/`no action needed`/`fyi only`, or `assessment unavailable` is **accepted**. `Engine.decide` exists (`src/core/engine.ts:38-41`), but the router tool list is `create_worker`, `stop_worker`, `reply_user`, `subscribe_worker` (`src/harness/tools.ts:126-175`); no tool calls `decide`. `Runtime.ingest` never calls it either. The only callers are tests (`test/ports.test.ts:35,47,217`).

The launch path is still parallel:

```ts
// src/harness/loop.ts:70-73
const work = Promise.all([
  this.enqueue('router', () => this.run('router', 'router', undefined, routerPrompt)),
  this.enqueue(sessionId, () => this.run(sessionId, 'worker', ticket.id, task.join('\n'))),
])
```

`assignmentStarted` is called before both (`src/harness/loop.ts:51-53`), so the assignment exists before the Router model has spoken. The demo log shows the order: `Evals.batch ... size=1`, `Tickets.create`, `Assignments.start`, `WorkerSession start`, then the Router turn.

**Grade High.** The deterministic gate before launch is a real improvement over `docs/REVIEW.md` H2, and `ignore`/`stop`/`unavailable` are tested (`test/highs.test.ts:32-117`). But "Router is the sequence point" (`README.md:47`) is still false, and `accept` remains the default for ordinary text. A Router assessment tool (or a `decide` call wired into the launch path) is missing.

### H5. Spill ACL is bypassable from the worker shell

**Code.** `readSpillFor` enforces ticket/session grants and pages correctly (`src/memory/acl.ts:26-50`), and `test/highs.test.ts:160-211` covers the tool. But the same worker has `bash`, and a non-isolated worker shell has no path restriction (`src/env/local-env.ts:93,97-101`). The SQLite database lives at `<home>/ds-agent.db`; the worker cwd is `<home>/workspaces/<session>`, so `../../ds-agent.db` is two levels up.

**Reproduced.** A sentinel spill was written, the store was closed (WAL checkpointed), and a worker shell ran `grep -a -o '<sentinel>' ../../ds-agent.db*`; it returned the sentinel. The ACL is an application-layer check on `read_object`, not a process boundary. Combined with C1's `meta.spillId` grant, the tool-level ACL is not sufficient to keep one ticket's spill out of another ticket's worker.

**Grade High.** Move the database outside the workspace root (or make the workspace a different mount), and make `bash` read-only outside its workspace when the ticket is not the grant owner; `DS_AGENT_SANDBOX=1` is not the default.

## Medium

### M1. Batching is still one trigger on the real path

`Runtime.ingest` calls `evaluateDue()` before returning (`src/runtime.ts:202-208`), and `nextBatch` returns a copy of `pending` (`src/ingress/batch.ts:1-4`; `src/core/evals.ts:21-22`). `ingest` is synchronous, so a second trigger cannot sit in `pending` across an ingest. Probe with three same-thread, non-human triggers: every `Evals.batch` was `size=1`.

`runBatchingStress` reaches `batchSizes: [32, 32]` by calling `engine.receive` 32 times before one `evaluateDue` (`src/metrics/batching-bench.ts:83-96`), which bypasses `Runtime.ingest`. The test is honest about being a bench (`:14-15`), but `README.md:40,50` marks "Router batches Triggers" and "Under load ... fold into the next Eval" as `[x]`, and the demo's batches are all `size=1`. The only real folding path today is a `handback` requeue followed by the next ingest (`src/core/subscribe.ts:20-24`).

### M2. `roleModels` is not implemented

`Runtime` constructs one model (`src/runtime.ts:88`) and `Harness` passes that same model to every role (`src/harness/loop.ts:183`). There is no `roleModels` in `src/`; the only occurrences are `README.md:49`, `README.zh-CN.md:49`, and `PLAN.md`. A live run sends Router, Worker, and Watchdog turns to the same model id. The README checkbox is a plan statement, not a branch behavior.

### M3. Watchdog residuals

The timer path now acts: `tick` nudges with a journal entry and event, and fails on the second tick or after two failed jobs (`src/watchdog/watchdog.ts:88-92,106-132`). What remains:

- `nudge_worker` is a log-only tool (`src/harness/tools.ts:370-374`); it does not append the session event that `Watchdog.nudge` appends.
- `stuckAssignments` skips any assignment with a `report` (`src/watchdog/watchdog.ts:40`), including a `progress` report whose verdict is `hold`. A worker that reports progress and then hangs is never stale-detected.
- The tick's `fail` calls `engine.report` directly and does not call `settleSpeculation` (`src/watchdog/watchdog.ts:123-132`), so a speculative scratch directory survives a watchdog fail.

### M4. DeliverGate is a keyword heuristic

The gate is wired (`src/core/assignments.ts:48`, `src/speculate/gate.ts:37-45`), and the discard path ends the assignment and emits `speculate.discarded` (`test/speculate.test.ts:97-132`). The policy itself is thin: `NEGATIVE` is tested before `POSITIVE` across the whole report (`src/speculate/gate.ts:28-34`), so a ready report that says "could not reproduce the first symptom, but fixed the timeout" discards; `deliver === true` bypasses the value check entirely (`:43`). This is a heuristic, not the "value signal" the plan describes. It is acceptable as a stand-in if the limitation is documented; it should not be used to claim the model's judgment.

### M5. Two speakers, and the outbox row is "sent" at insert

`Tickets.create` acknowledges every non-speculative ticket (`src/core/tickets.ts:89`), and the Router also calls `reply_user` (`src/harness/tools.ts:153-163`). `Replies.send` inserts the row, logs it, and immediately marks it sent (`src/core/replies.ts:24-36`); there is no outbox adapter. This is pre-existing (`docs/REVIEW.md` M1) and unchanged. The new `maySurface` check prevents speculative copies, but it does not make the two non-speculative copies one.

### M6. Subscription residuals

`bypassEligible` checks `trigger.human`, `ticket.ended`, and a non-empty `mandate.scope` (`src/core/intake.ts:109-114`). It does not check `mandate.actor`, `mandate.strength`, or a `contextOnly` flag. `Thread.subscriptions` is still `string[]` (`src/shared/types.ts:48`), not the plan's `{ ticketId, contextOnly }`; ended tickets are filtered at read time but never pruned from the thread list. The core bypass/arbitration behavior is fixed; these are the remaining predicate gaps.

### M7. `HttpOpenAI` rejects a turn on malformed tool arguments

`fetch` has no timeout (`src/harness/model.ts:178`), and tool arguments are parsed without a catch (`src/harness/model.ts:224-228`). `model.complete` sits outside the per-tool try in `runTurn` (`src/harness/loop.ts:253`), so a malformed argument string rejects the turn. With H3, the assignment stays `running` until the watchdog notices. This is pre-existing (`docs/REVIEW.md` M7).

### M8. `stop_job` does not stop the timer

`stop_job` calls `store.completeJob(jobId, 'stopped')` and returns `{ status: 'stopped' }` (`src/harness/tools.ts:345-353`). The timer created by `scheduleJob` still fires, calls `completeJob(job.id, 'succeeded')`, and enqueues a `JOB_DONE` turn (`src/harness/loop.ts:89-117`). The model is told the job stopped; the job later succeeds and runs another turn.

### M9. The live suite and the demo are not deterministic gates

The default suite and demo refuse `MockModel` (`src/cli/demo.ts:33-45`, `test/fixtures.ts:11-23`), which is the intended product choice, but it makes them model-timing gates:

- Stored full run in `/tmp/ds-agent-live-e2e-logs/vitest-full.txt`: **109 passed / 4 failed** (`job`, `metrics`, `ports`, `subscription`).
- This pass, deterministic subset: **29 passed / 1 failed** (`test/ports.test.ts:197`, 180 s timeout).
- This pass, subscription/highs/spill: **18 passed / 1 failed** (`test/subscription.test.ts:49`, 180 s timeout).
- `pnpm demo` exited 0 and printed `demo ok (live model)`, but the log says `jobsSettled outcome=deadline`; after exit, all three tickets had `ended: null` and their last assignment `state: "running"` with no report, and `ticket_3` was still `speculative: true`. The demo never reached `speculate.delivered` or `speculate.discarded`.

Some assertions depend on a live model choosing a tool: `test/job.test.ts:24-33` expects `start_job`, and `test/metrics.test.ts:78-88` expects exactly one `speculate.deliver`. A green run is evidence that the model followed the prompt that day, not that the control plane is closed. The method's guidance applies: add a behavioral assertion that fails when the branch is removed, and do not treat a log substring or a model's tool choice as proof.

### M10. README status lines still overclaim

`README.md:47` ("Router is the sequence point"), `:49` (`roleModels.router`), and `:50` ("Under load ... fold into the next Eval. Demo and tests cover it") are not true of this tree. `README.zh-CN.md:226,265` still says a missing key falls back to `MockModel`, while `demoModel` throws (`src/cli/demo.ts:33-38`). The method treats PLAN/README status lines as 中 because agents implement from them.

## Verification of #7 / #9 / #11 / #13 / #15

### #7 — Subscription arbitration: **fixed**

- `bypassEligible` is now human-only, rejects ended tickets, and requires a non-empty mandate scope (`src/core/intake.ts:109-114`).
- `arbitrateSubscribers` selects one winner by assignment rank, then latest activity, then creation (`src/core/intake.ts:117-151`); `Intake.receive` adds the input to that one ticket and records a one-element fan-out (`src/core/intake.ts:55-70`).
- `test/subscription.test.ts:49-123` covers non-human, ended, and blank-scope rejection; `:165-210` covers arbitration; `:213-267` covers the pure predicates. The `reject-non-human` live test timed out at 180 s in this pass, but the pure predicate tests passed and the first fan-out test passed.
- Residual: no `contextOnly`, no actor/strength re-check, stale entries not pruned (M6).

This closes `docs/REVIEW.md` H3's main claim ("bypass is not human-only; resume only clears ended"). Resume is also no longer a path: `Assignments.report` returns `hold` for `ticket.ended.by === 'human'` (`src/core/assignments.ts:44`) and `bypassEligible` rejects any ended ticket.

### #9 — ToolContext Engine leak: **fixed**

- `RolePorts` splits the Engine into `RouterPorts`/`WorkerPorts`/`WatchdogPorts` (`src/shared/ports.ts:49-99`); `bindRolePorts` builds each surface and seals the router-only names (`src/core/role-ports.ts:21-81`).
- `ToolContext` is role-discriminated and carries `ports`, not `engine` (`src/harness/tools.ts:21-40`); `ToolDeps` has `ports: RolePorts` (`:30-40`). `HarnessOptions` has no `engine` (`src/harness/loop.ts:12-24`).
- `assertSessionMay` refuses `reply`/`decide`/`receive` inside a worker or watchdog turn via `AsyncLocalStorage` (`src/core/session-role.ts:6-22`), which catches code that reaches the Engine directly rather than through a port.
- `test/ports.test.ts:50-255` covers the type-level and runtime refusals, including a worker model that tries `reply_user`.

This closes `docs/REVIEW.md` C1's control-plane half and `PLAN_SOLIDITY_OPUS.md` C3. Note that `Runtime` still passes the concrete `Engine` to `Watchdog` (`src/runtime.ts:150-158`), but the watchdog is a privileged control loop, not a worker, and its tool surface is `WatchdogPorts`.

### #11 — Gate sequence: **partial**

- Fixed: the deterministic Eval runs before any worker launch. `Runtime.ingest` calls `evaluateDue()` and launches only `accept` decisions (`src/runtime.ts:202-207`); `ignore`/`stop`/`unavailable` do not launch (`src/core/evals.ts:39-58`; `test/highs.test.ts:32-117`).
- Not fixed: the Router is not the assessment and is not a sequence point. `Engine.decide` has no tool (`src/harness/tools.ts:126-175`), the default is `accept` (`src/core/assessment.ts:40-41`), and `Harness.launch` starts Router and Worker together (`src/harness/loop.ts:70-73`). The demo shows `WorkerSession start` before the Router turn.

So the "Gate" half is real; the "Router Assessment then accept" half is still the plan, not the branch.

### #13 — Spill ACL: **partial**

- Fixed at the tool: `readSpillFor` requires `ticket:<id>` or `session:<id>` (`src/memory/acl.ts:34-37`), pages at `SPILL_PAGE = 200` (`:5,38-50`), and `test/highs.test.ts:160-211` proves a granted reader gets one page and another ticket/session is refused.
- Not fixed at the trust boundary: `Tickets.create` grants `primary.meta.spillId` (`src/core/tickets.ts:24,60`), and `Runtime.ingest` preserves a caller-supplied short-text `spillId` (`src/runtime.ts:186-192`). Reproduced: a short trigger granted an existing `spill_1` to a new ticket.
- Not fixed at the process boundary: a worker's `bash` can read `<home>/ds-agent.db` (H5).

The tool-level ACL is a real improvement over `docs/REVIEW.md` H7's "no ACL"; it is not yet a confidentiality boundary.

### #15 — Journal ReAct: **fixed**

- `runTurnBody` loads `journal.history(sessionId)`, redacts it, and prepends it to the system + current prompt (`src/harness/loop.ts:238-247`); `messagesFromJournal` reconstructs user/assistant/tool messages including `toolCalls` and `toolCallId` (`:287-300`).
- `SessionJournal.history` reads SQLite messages when open and the JSONL file otherwise (`src/harness/session.ts:47-66`).
- `test/highs.test.ts:213-267` runs two turns and asserts the second model call contains the first turn's `TASK`, `worker-ok` tool result, and the new `JOB_DONE` prompt at an index greater than the prior history.

This closes `docs/REVIEW.md` H5's "journal is write-only" claim. The remaining concern is context growth: `history` is unbounded and every turn replays all prior entries; that is an efficiency issue, not the ReAct gap.

## `docs/REVIEW.md` delta (stale claims re-checked)

| REVIEW.md | 2026-10-31 claim | This tree (2026-11-01) | Status |
|-----------|------------------|------------------------|--------|
| C1 | Bash puts env values into the next prompt; `sanitize.ts` absent | `src/env/sanitize.ts` exists; child env allowlisted; stdout/stderr and prompt/journal redacted | **Mostly fixed**; spill body still raw (H1) |
| H1 | `meta.admitted` admits dropped triggers | Unchanged, and now also grants `meta.spillId` | **Open / Critical** (C1) |
| H2 | Eval cannot refuse; Router not sequence point | Assessment has ignore/stop/unavailable; Router still not wired | **Partial** (#1/#2/#11) |
| H3 | Bypass not human-only; resume only clears `ended` | Human-only, ended/scope checks, one-winner arbitration, no resume | **Fixed** (#7) |
| H4 | Deliver gate is the worker's boolean; `maySurface` unused | `DeliverGate` + `maySurface` used; discard ends assignment | **Fixed** (#4/#5/#12) |
| H5 | Session journal is write-only | `history()` drives the next turn | **Fixed** (#15) |
| H6 | Watchdog tick only logs | Tick nudges (journal + event) then fails via `Engine.report` | **Fixed** with residuals (M3) |
| H7 | `read_object` returns the whole spill, no ACL | Paged + ticket/session ACL | **Partial** (H5, #13) |
| H8 | Live mode does not run the policy the demo proves | Still one model for all roles; live suite is model-timing | **Open** (M2/M9) |
| H9 | Shell timeout does not release the worker turn | Unchanged | **Open** (H3) |
| H10 | Close during a turn threw `database is not open` | Guard remains in `Harness.run`/`SessionJournal.append` | **Fixed** |
| M1–M8 | Outbound, mock tokens, handback, norms, API errors | Outbound rows still marked sent at insert; `handback` now unsubscribes; `JSON.parse` still unguarded | **Mixed** (M5/M7) |
| L1–L4 | Types, scripts, dead helpers, log-only tests | Events now include speculate/watchdog; `REASONS` and `Thread.correlated` still unused; tests still lean on live logs | **Mixed** |

## What holds

- **Role separation.** Workers hold `WorkerPorts`, not the Engine; `reply`/`decide`/`receive` are refused both by type and by the `AsyncLocalStorage` guard (`src/shared/ports.ts`, `src/core/session-role.ts`, `test/ports.test.ts`).
- **Deliver gate.** Speculative replies are held (`src/core/engine.ts:64-68`), discarded assignments end and emit `speculate.discarded`, delivered ones clear `speculative` and emit `speculate.delivered` (`src/core/assignments.ts:59-83`).
- **Spill paging.** `read_object` returns one 200-character page with `offset`/`nextOffset`/`truncated` (`src/memory/acl.ts`).
- **Journal history.** The next model call includes prior turns (`src/harness/loop.ts:238-247`).
- **Watchdog mutation.** The timer path can end an assignment and records `watchdog.nudge`/`watchdog.fail` events (`src/watchdog/watchdog.ts`).
- **Admission filter.** Noise is dropped on the fast path or the semantic rules; a duplicate id returns `duplicate`; a source not in `im|github|cli` is dropped (`src/ingress/filter.ts`, `test/filter.test.ts`).
- **Env allowlist.** Secret-named env entries are not copied into the child even if listed; stdout/stderr are redacted (`src/env/sanitize.ts:49-60`, `src/env/local-env.ts:46,111-112`, `test/sanitize.test.ts`).

## Evidence / commands run

| Command | Result |
|---------|--------|
| `pnpm typecheck` | pass (`tsc --noEmit`, no output) |
| `npx vitest run test/sanitize.test.ts test/vault.test.ts test/speculate.test.ts test/ports.test.ts test/health.test.ts test/batching-bench.test.ts` | **29 passed, 1 failed** — `test/ports.test.ts:197` timed out at 180 s |
| `npx vitest run test/subscription.test.ts test/highs.test.ts test/spill.test.ts` | **18 passed, 1 failed** — `test/subscription.test.ts:49` timed out at 180 s |
| `pnpm demo` (live Magpie) | exit 0, `demo ok (live model)`, but `jobsSettled outcome=deadline`; every `Evals.batch` was `size=1`; all three tickets were still `running` with no report after exit |
| Stored full run `/tmp/ds-agent-live-e2e-logs/vitest-full.txt` | **109 passed, 4 failed** (`job`, `metrics`, `ports`, `subscription`) |
| Probes (`Runtime.ingest` + `LocalEnv`) | reproduced C1 (`meta.admitted`, `meta.spillId` grant), H1 (spill body), H2 (spec path), H3 (2010 ms for a 300 ms timeout), H5 (DB read from a worker shell) |

The focused tests that matter for the five controls pass: `test/highs.test.ts` (gate/assessment, watchdog tick, spill ACL, journal turns), `test/speculate.test.ts` (gate/discard/workdir), and `test/ports.test.ts` (role ports). The failures are live-model timing/behavior failures, not failures of those assertions.

## PR checklist

```text
Testing:
- pnpm typecheck: pass
- pnpm test: not green in this pass. Focused files: 29/30 and 18/19; both failures are 180s live-model timeouts.
- pnpm demo (live): exit 0, "demo ok (live model)", jobsSettled outcome=deadline.
Risk: 低 (docs-only)
How to revert: git revert the merge. This PR adds one file under docs/ and changes no runtime code.
```

Reviewer summary shape:

```text
1 Critical, 5 High, 10 Medium.
- Critical C1: untrusted trigger.meta still admits dropped triggers and grants arbitrary spill ids.
- High H1: spill bodies store credential values before redaction.
- High H2: speculative isolation is a string check; escape survives discard.
- High H3: shell timeout does not kill the process group; 2010 ms for a 300 ms timeout.
- High H4: Router does not assess or sequence; accept is the default.
- High H5: worker bash can read the SQLite spill table directly.
- Medium: batching is size 1 on the live path; roleModels absent; watchdog residuals; heuristic gate; two speakers; subscription predicate gaps; unguarded tool args; stop_job timer; flaky live suite; README drift.
#7 fixed, #9 fixed, #11 partial, #13 partial, #15 fixed.
```

## Note on `docs/REVIEW.md`

`docs/REVIEW.md` remains useful as the 2026-10-31 baseline, but its status column is stale: `sanitize.ts` now exists, `maySurface` is called, `read_object` is paged, the journal is read, the watchdog acts, and workers no longer hold the Engine. Do not cite its `C1`/`H3`/`H4`/`H5`/`H6`/`H7` statuses as current. The findings that remain current are H1 (now C1), H8 (role models/live policy), and H9 (shell timeout); H2 is partial.
