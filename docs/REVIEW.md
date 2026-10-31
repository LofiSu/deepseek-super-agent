# ds-agent review

Author: LofiSu  
Date: 2026-10-31  
Scope: `PLAN.md` (the M0–M11 contract) against the TypeScript in `src/`. Read-only except for one shutdown crash, called out at the bottom. This is not an official DeepSeek review.

Axes:

- **A.** Architecture coherence of the dual Router/Worker, Ingress Fast/Slow, Engine Intake → Eval → Ticket → Assignment, subscription bypass, Inline/Spill, speculative deliver gate, async ReAct, channel norms, Store vs Env BYOM, and Watchdog.
- **B.** Code against that architecture: bugs, races, error handling, domain writes, credential leakage, Mock vs live model.
- **C.** Severity with `file:line`.

## Methodology article

No Cloud or Claude code-review methodology article is referenced in this repo.

Searched: the working tree, and every commit (`git grep` across `git rev-list --all`, plus `git log -S` for `Cloud`, `Claude`, `code review`, and `methodology`). The only Cloud hits are BYOM wording, not a review rubric:

- `src/cli/main.ts:29` — "Cloud model: DS_AGENT_API_BASE + DS_AGENT_API_KEY"
- `src/shared/ports.ts:13` and `src/env/local-env.ts:8` — a future cloud worker implementing `EnvPort`
- `test/filter.test.ts:107` — "cloud env vars"

Nothing cites a methodology post, and this review does not import one. Findings below are from the plan text and from running the code (Node v22.23.4, `pnpm test`, `pnpm demo`, and small Runtime scripts against this tree).

## Verdict

`pnpm demo` under MockModel prints the blog's vocabulary: two-level filter, `bypass=subscription`, spill id, speculative silence, `deliver=true`, a watchdog tick, an async job. Those strings are real. The control plane the plan describes is not what runs.

The Router does not decide. Eval always accepts. A batch is one trigger. Subscription bypass is every live subscriber, not a human message. The deliver gate is a boolean the worker sets. The session journal is write-only. The watchdog logs. The shell inherits `DS_AGENT_API_KEY` and returns it as a tool result. Turning on `DS_AGENT_API_*` switches the model client and drops the scripted proofs; it does not turn those behaviors into model policy.

PLAN §4 says the TypeScript shapes are frozen and that code changes follow the plan. `src/shared/types.ts` is a different model (`Role`, `Strength` includes `maybe`, `Thread.subscriptions: string[]`, `Assignment.state`, no `Engine.decide`). PLAN §10's file tree (`roles.ts`, `sanitize.ts`, `prompts/`, `src/app/runtime.ts`, `Assessor`) is not the tree that shipped. The audit at PLAN lines 1013–1033 then marks that drift as covered. README checkboxes that say `[x]` for batching, a model slow path, `roleModels`, the deliver gate, daemon resume, and the credential baseline describe the plan, not the branch.

| ID | Sev | Status | Topic |
|----|-----|--------|--------|
| C1 | Critical | open | Credential values reach the model context through bash |
| H1 | High | open | `meta.admitted` admits triggers the filter just dropped |
| H2 | High | open | Eval cannot refuse; the Router is not the sequence point |
| H3 | High | open | Bypass is not human-only; resume only clears `ended` |
| H4 | High | open | Speculative work is not hidden and cannot be discarded |
| H5 | High | open | The session log is not the next turn |
| H6 | High | open | Watchdog does not nudge or fail |
| H7 | High | open | `read_object` puts the whole spill back into the prompt |
| H8 | High | open | Mock policy does not transfer to the live model |
| H9 | High | open | The shell timeout does not release the worker turn |
| H10 | High | fixed here | Closing SQLite during a turn threw `database is not open` |
| M1–M8 | Medium | open | Outbound, mock tokens, handback, norms, API errors |
| L1–L4 | Low | open | Types, scripts, dead helpers, missing probes |

## Critical

### C1. Bash puts environment values into the next prompt

**A + B.** PLAN line 9, T51 (line 267), §2.5 Env row (line 182), the `LocalEnv` port comment (line 558), and the acceptance probe (lines 584–585) say credential values never enter tool results or prompt assembly. Names may. Values may not. M9 was supposed to ship `src/env/sanitize.ts` and a test that redacts. That file is not in the tree. No test searches session text for env values.

`LocalEnv.bash` spawns the user's shell with the parent environment. Node's default for `spawn` is `env: process.env` when `env` is omitted.

```ts
// src/env/local-env.ts:26-32
const child = spawn('bash', ['-c', command], { cwd, timeout: this.timeoutMs })
let stdout = ''
let stderr = ''
child.stdout.on('data', chunk => { stdout += String(chunk) })
child.stderr.on('data', chunk => { stderr += String(chunk) })
child.on('error', reject)
child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
```

The worker tool returns that stdout and stderr unchanged (`src/harness/tools.ts:101-104`). `runTurn` JSON-encodes the result into the next `messages` array (`src/harness/loop.ts:223-228`) and `HttpOpenAI.complete` posts those messages to the API (`src/harness/model.ts:164-196`). `SessionJournal.append` also writes the same line to SQLite and to `sessions/<id>.jsonl` (`src/harness/session.ts:22-26`).

Reproduced: with `DS_AGENT_API_KEY` set to a sentinel, `env.bash(worker, 'echo KEY=$DS_AGENT_API_KEY')` returned `code: 0` and the sentinel in `stdout`. The same call `cat ../../../../etc/hostname` from the worker directory returned the host file. `safe()` (`src/env/local-env.ts:47-54`) applies to `readFile` / `writeFile` only. `bash` is arbitrary execution with the process environment, network, and filesystem.

The worker prompt is the trigger text (`src/harness/loop.ts:48-55`, `72-79`). IM and GitHub bodies are untrusted. A live model that follows "print the environment" instructions, or a Mock script that is later pointed at a different command, puts the API key in the journal and in the following completion request. MockModel's own script only runs `echo worker-ok` (`src/harness/model.ts:124`), so `pnpm demo` does not trip the probe. The probe was never written.

This is the project's own red line, and the tool that crosses it is on by default for every worker.

## High

### H1. The filter's drop verdict loses to `meta.admitted`

**A + B.** `Trigger.meta` is documented as untrusted (`src/shared/types.ts:25`). PLAN line 300 says the same thing: core does not interpret `meta`. Ingress is supposed to be the only admission gate (PLAN §2.2, T16–T17).

`Runtime.ingest` runs `filterTrigger` and logs the verdict (`src/runtime.ts:127-130`). On a drop it forwards the original trigger (`src/runtime.ts:131-145` only rewrites `meta` when `action === 'pass'`). Engine admission then trusts a flag on that object:

```ts
// src/runtime.ts:66-71
admit: trigger => {
  if (trigger.meta.admitted === true) return { listened: true, reason: 'admitted' }
  const verdict = filterTrigger(trigger, model)
  if (verdict.action === 'drop') return { listened: false, reason: `${verdict.layer}:${verdict.reason}` }
  return { listened: true, reason: verdict.reason }
},
```

Reproduced with an IM noise trigger (`lol nice weather today haha`, `addressed: false`) plus `meta.admitted: true`:

- the ingress line was `action=drop layer=fast`
- `Engine.receive` returned `stored`
- Eval created `ticket_1` and `Replies.acknowledge` sent an IM acknowledgement of the noise text

So the log says dropped and the user is told the agent is working on it. Channel adapters in this tree set `meta` themselves, so the CLI does not hit this today. The composition root still treats an untrusted field as the bypass around the filter it just computed. The same object carries `meta.strength` (`src/core/evals.ts:35-39`), `meta.speculate` (`src/speculate/gate.ts:2-4`), `meta.spillId` (`src/core/intake.ts:101-102`), and `meta.label` (`src/core/tickets.ts:20`). Those decide strength, silence, which blob is read, and the ticket title.

### H2. There is no Gate, and the Router does not sequence work

**A + B.** PLAN §2.3 steps 4–5 and the `Engine` port (`decide`, `AssessmentOutcome` at PLAN lines 426–460) say a trigger waits for Gate (deterministic) plus Assessment (Router session), and only `accept` creates Mandate + Ticket + Assignment. The Router is the sequence point (PLAN line 203, T06, T08): light model, no bash, batch the triggers that arrived during the round, then workers run.

What runs:

1. `Evals.evaluateDue` loads every thread with a non-empty `pending`, takes all of those ids, and calls `tickets.create` (`src/core/evals.ts:9-29`). There is no `ignore`, `stop`, or `unavailable` branch. `Decision.kind` is hard-coded `'accept'` (`src/core/tickets.ts:66-76`).
2. `nextBatch` returns a copy of `pending` (`src/ingress/batch.ts:1-3`). `Runtime.ingest` calls `evaluateDue` before returning (`src/runtime.ts:153-158`), so a second trigger cannot sit in `pending` across an ingest. Every demo batch line is `size=1`.
3. `Harness.launch` starts the Router turn and the Worker turn with `Promise.all` (`src/harness/loop.ts:63-66`). The worker is already going before the router turn has produced a decision. `create_worker` records a log line and returns `{ status: 'engine-assigns' }` (`src/harness/tools.ts:42-49`). The assignment was created before the model was called.

The router tool list really does omit `bash` (`src/harness/tools.ts:97-100` is `roles: ['worker']`, and `invoke` rejects a cross-role call at `src/harness/tools.ts:230-232`). That part of T06 holds. It does not make the Router the sequence point. Assessment cannot say no.

`onQueued` only logs the pending count (`src/runtime.ts:74-76`). Nothing drains an inbox at turn start.

### H3. Subscription bypass does not match the human/live rule, and resume does not reopen work

**A + B.** PLAN §2.3 and T19: a **human** message that reaches a **live** ticket bypasses Eval, and the log line contains `ticketId`. An ended ticket that was not stopped resumes. `contextOnly` subscriptions do not grant follow-up (M5). The log probe itself works: `src/core/intake.ts:59-60` prints `bypass=subscription ticketId=…`, and `test/subscription.test.ts` locks that for a second human message on the same thread.

The fan-out condition is "the ticket is deliverable", and a ticket with no `ended` is deliverable for every trigger (`src/core/intake.ts:73-74`, loop at `38-53`). Reproduced: after a human `@ds-agent please fix…` on `im:topic/bug`, a `human: false` CI-style message on that same thread was `stored` with `fanout: ['ticket_2']` and the bypass log line. Eval did not see it. Bot and CI traffic on a subscribed thread skips the router.

Resume is `delete ticket.ended` (`src/core/intake.ts:77-80`). Nothing else changes. Reproduced after `report({ kind: 'ready', deliver: true })`:

- the follow-up human message cleared `ended`
- the only assignment stayed `state: 'ended'`
- no new assignment was created
- the input list grew, and `harness.deliver` still runs another worker turn (`src/runtime.ts:159-160`)

`ended.by === 'human'` is the one case that refuses resume (`src/core/intake.ts:75`). No path sets `by: 'human'`. There is no `stopTicket`. `Engine`'s public surface is `receive`, `evaluateDue`, `assignmentStarted`, `report`, `reply`, `subscribe`, `handback` (`src/core/engine.ts`). A finished ticket is reopened by the next human message forever, while `ticketStage` still sees an ended assignment and reports `person/review` (`src/core/stage.ts:6-9`).

`Thread.subscriptions` is `string[]` (`src/shared/types.ts:48`), not PLAN's `{ ticketId, contextOnly }`. Every subscription is a full bypass.

### H4. The deliver gate is the worker's boolean

**A + B.** PLAN §2.3, T26–T28, and `DeliverGate.evaluate` (lines 533–539, 714–718): a speculative assignment stays invisible; `ready` plus a value signal delivers and clears `speculative`; `dropped` / `failed` discards with no outbound message; events `speculate.delivered` and `speculate.discarded`. The public ticket list excludes speculative rows until deliver (line 584).

`maySurface` (`src/speculate/gate.ts:6-9`) is never called. `Assignments.report` does this instead:

```ts
// src/core/assignments.ts:35-46
if (ticket.speculative && report.deliver !== true) {
  this.host.repo.putDoc('ticket', ticket.id, ticket)
  this.host.log(`[speculate] speculative silent ticketId=${ticket.id} deliver=false`)
  return { surfaced: false }
}
if (report.deliver === true) {
  const tag = ticket.speculative ? '[speculate] ' : ''
  this.host.log(`${tag}deliver=true ticketId=${ticket.id}`)
}
if (report.kind === 'ready' || report.kind === 'dropped' || report.kind === 'failed') {
  assignment.state = 'ended'
```

Reproduced on the demo's flaky-test trigger (`meta.speculate: true`):

- `report({ kind: 'failed', text: 'watchdog: stuck', deliver: false })` left `ended` unset, `state` `running`, `speculative` true. That is the payload `mark_task_failed` sends (`src/harness/tools.ts:213-214`). A speculative ticket cannot be failed through the only fail API, because the silence return happens before the terminal branch.
- `report({ kind: 'ready', deliver: true })` set `ended` and left `speculative: true`. No `speculate.delivered` event exists (`src/shared/events.ts:1-11`).

`list_tasks` returns speculative rows (`src/harness/tools.ts:79-84`). `ds-agent tasks` prints every ticket (`src/cli/main.ts:71-74`). `Engine.reply` does not look at `speculative` (`src/core/engine.ts:45-50`), so a Router tool call speaks even when the report said not to deliver. MockModel avoids that with prompt text (`src/harness/model.ts:105-107`). The engine does not.

MockModel's speculative script always delivers on the second report (`src/harness/model.ts:128-145`: progress `deliver: false`, then `ready` / `deliver: true` with the fixed sentence `ready: investigation recorded`). The demo's "might be a flaky payment test" still produces a GitHub result. The value heuristic is "the mock said true".

### H5. Async ReAct does not continue a session

**A + B.** T29–T32 and the `Harness` port: `start` / `stop`, a tool result of `{ status: 'started', jobId }` must not block the turn, and completion is a new session event that the next turn can see. Duplex means inbound events and tool results share one log. T04 / T36 and the daemon section: on boot, resume unfinished sessions and jobs from the store. D8 is "restart restores Session/Ticket".

`runTurn` builds a two-message transcript every time (`src/harness/loop.ts:201-205`): the role's system prompt plus the single prompt string. The journal is appended (`src/harness/session.ts:17-30`) and never read. `Harness` has `launch`, `deliver`, `routerTurn`, `watchdogTurn`. It does not have `start`, `stop`, or `injectJobResult`. `Daemon` arms a timer (`src/harness/daemon.ts:10-19`) and does not load sessions or jobs.

`start_job` returns `{ status: 'started', jobId }` (`src/harness/tools.ts:173-183`) and the same `runTurn` loop keeps calling the model. MockModel then reports ready in that same turn, before the timer fires (`src/harness/model.ts:124-145`). The completion path enqueues a new turn whose prompt is only `JOB_DONE\njobId=…` (`src/harness/loop.ts:90-94`). That turn cannot see the earlier tool results.

A follow-up is the same shape. `deliver` prompts with `FOLLOWUP` plus the new text (`src/harness/loop.ts:72-79`). MockModel does not see `JOB_DONE` in that blob, so it runs bash, write, `start_job`, and `report_to_router` again. `pnpm demo` shows this: `ticket_1` gets a second `ready: investigation recorded` and `job_4` after `trg_login_2`. The subscription bypass is wired. The worker treats the follow-up as a brand new task and the router sends another result.

Restart persistence in the demo counts ticket rows (`src/cli/demo.ts:114-126`). The rows are there. The in-flight turn is not reconstructed. `package.json` has no `serve` daemon distinct from this timer. README's "进程重启后可恢复" is the row count.

Per-session `enqueue` (`src/harness/loop.ts:146-150`) does serialize turns on one session id, and ingress does not await `launch`, so a new trigger can be stored while a turn is in flight. That slice of "continuous" holds. The model still sees only the new prompt.

### H6. The watchdog cannot change an assignment

**A + B.** T41–T44: an external control loop on its own session, timer-driven, that detects a running assignment with no report, repeated job failure, and mandate drift, then nudges (a session event) or fails the assignment and tells the Router. `prompts/watchdog.md` is not in the tree.

Two mechanisms exist and neither acts:

- `Watchdog.tick` reads SQLite health and logs `nudge` for worker rows whose **session** status is `running` and whose heartbeat is old (`src/watchdog/watchdog.ts:4-8`, `24-32`). It does not call `nudge_worker`, `mark_task_failed`, or `Engine.report`.
- The watchdog model turn lists tasks and, under MockModel, returns `[watchdog] healthy` (`src/harness/model.ts:86-89`). `nudge_worker` logs and returns `{ nudged }` (`src/harness/tools.ts:197-205`). It does not append a session event.

The stuck signal is the wrong one. `Harness.run` sets the session to `running` at the start of a turn and to `idle` in `finally`, including when the turn throws (`src/harness/loop.ts:153-184`). A model or HTTP error rejects the turn, the session row goes `idle`, and the assignment stays `running` because nothing calls `report`. `stuckSessions` ignores idle rows and ignores assignment age. PLAN's condition was "assignment running with no report". After a failed turn the watchdog's detector goes quiet.

`mark_task_failed` has a second hole, already under H4: speculative tickets swallow `kind: 'failed'` when `deliver` is not true. Heartbeats also freeze during `await model.complete` and during `await env.bash`, because the journal is not written while those promises are pending. A long call looks stuck, and the response is a log line.

### H7. Spill does not keep the body out of the prompt

**A + B.** T23–T25: Inline is `{ summary, spillIds }`. `read_object` returns a page, `truncated`, `nextOffset`, and neighbors. The body stays in the spill until something asks for a range.

`inlineOrSpill` does spill past 180 characters and keeps a 72-character summary (`src/memory/recall.ts:10-15`). `Runtime.ingest` then **replaces** `trigger.text` with that summary (`src/runtime.ts:132-145`), so the stored trigger is not the source event. The original bytes live in the SQLite `spills` table (`src/store/sqlite.ts:131-139`), not in `<stateDir>/spill/<id>` files. `putSpill` commits before `Engine.receive`'s transaction. A throw from intake leaves an orphan spill and no trigger.

`read_object` loads the entire body and returns it as `text` (`src/harness/tools.ts:128-138`). There is no offset, no neighbor query, and no ACL: any worker who knows or guesses a spill id gets the whole object. The spill test requires the full CI log to come back (`test/spill.test.ts:27-38`). The demo log is `read_object id=spill_1 bytes=355` and the next model step sees that tool result. For the long CI trace the plan uses as the example, spill is a round trip into the prompt, not a boundary.

### H8. Live mode does not run the policy the demo proves

**A + B.** T07 and T10, and README's model section: Router and Watchdog use a light model, the Worker a stronger one (`roleModels`). T17: the slow path is an LLM policy, with Mock allowed to substitute rules. `createModelFromEnv` returns one `HttpOpenAI` or one `MockModel` for every role (`src/harness/model.ts:219-223`). `HttpOpenAI.classify` calls `ruleClassify` (`src/harness/model.ts:160-162`), the same keyword function MockModel uses (`src/harness/model.ts:79-81`, rules in `src/ingress/filter.ts:50-66`). Setting `DS_AGENT_API_BASE` and `DS_AGENT_API_KEY` does not send triggers to the model for admission.

The scripted behaviors that make the demo "prove" the blog live only inside `MockModel.complete`: speculative silence, `read_object` before bash, `start_job`, `deliver: true`, watchdog `list_tasks` (`src/harness/model.ts:83-147`). `LIVE_DEMO_PROOFS` (`src/cli/demo.ts:37-47`) drops `RouterSession`, `WorkerSession`, `spillId=`, `read_object`, `speculative silent`, `deliver=true`, `async job started`, and the watchdog tick. That list is an admission that those proofs are Mock-only. A live worker is not forced through the deliver gate (H4), not forced to page spills (H7), and not given a different model from the router.

Fast path is also thinner than T16. It allowlists `im` | `github` | `cli`, then mention, a keyword regex, or "not short and not the noise regex" (`src/ingress/filter.ts:33-44`). There is no actor allowlist, no group/chat allowlist, and no drop-self. The default GitHub actor is `ci-bot` (`src/channels/github.ts:17`) and still passes when the text matches `failed` or `error`.

### H9. `timeout` kills the shell and the turn keeps waiting

**B.** `LocalEnv` passes `timeout: this.timeoutMs` (default 5000) to `spawn` (`src/env/local-env.ts:12`, `26`). On Node v22.23.4 that timer delivers `SIGTERM` to the **bash pid**. It does not kill the process group. `LocalEnv` resolves on the `close` event (`src/env/local-env.ts:32`), which waits until every inherited stdio fd closes.

Measured: `spawn('bash', ['-c', 'echo PID $$; sleep 3; echo DONE'], { timeout: 500 })` emitted `exit` at ~504ms with `killed: true`, and `close` only at ~3004ms, with no `DONE`. The grandchild `sleep` held the pipe. A worker command of `sleep 3600`, or any child that outlives the shell, blocks that session's promise chain for the child's lifetime (`enqueue` will not start the next turn). The grandchild keeps running after the shell is dead. stdout is also appended without a cap (`src/env/local-env.ts:29-30`), so a command that prints forever grows the Node heap until the process dies. Watchdog will at most log, per H6.

`child.on('error', reject)` plus `child.on('close', resolve)` can also reject after the promise has already resolved, which is an unhandled rejection if `error` follows `close`.

## Medium

### M1. Two speakers, and the outbox is already "sent"

**A.** PLAN §2.2 says outbound replies go only through the Router. PLAN §2.3 step 5 says `accept` atomically writes an ack outbox row. Both happen. `Tickets.create` calls `replies.acknowledge` for every non-speculative ticket (`src/core/tickets.ts:82-83`). `Replies.send` renders channel text, inserts the row with `status: 'sent'`, and logs it (`src/core/replies.ts:16-30`). Nothing later delivers that row: there is no outbox adapter and no fake IM/GitHub sender. MockModel then calls `reply_user` with `Working on ${title}` (`src/harness/model.ts:108-114`), which is a second `purpose=result` line. `pnpm demo` shows both for ticket 1. The user-facing channel is the log.

`reply_user` is router-only at the tool registry (`src/harness/tools.ts:62-72`). `Engine.reply` itself has no role check (`src/core/engine.ts:45-50`). The "worker cannot speak" rule is the tool list, not the engine.

### M2. MockModel's control protocol is a substring of untrusted text

**B.** Router and worker decisions scan the whole transcript with `String.includes` (`src/harness/model.ts:93-146`). The transcript contains the ticket title and the trigger body. `deliver=false` is checked before `deliver=true` (`src/harness/model.ts:94-95`). A title that contains `deliver=false` makes the router return `[router] speculative silent` and skip `reply_user` on the create turn. A brief that contains `JOB_DONE` makes the worker return immediately (`src/harness/model.ts:121`) and skip bash, spill read, and the report. This is the model `pnpm demo` uses to claim those behaviors.

### M3. `handback` requeues without leaving the subscription

**A + B.** T21: handback / `markUnrelated` returns the trigger to Eval and drops the worker's claim. `unsubscribe` and `followForContext` are not implemented. `handback` (`src/core/subscribe.ts:6-22`) appends the trigger id to `pending` and leaves `thread.subscriptions` in place. It does not call `evaluateDue`. The next `ingest` does, and `evaluateDue` always accepts (H2), so the same trigger becomes a second ticket while the original ticket is still subscribed on that thread. The CLI never calls `handback`. The function is still on `Engine`.

### M4. `stop_worker` and `create_worker` report success without changing state

**B.** `stop_worker` logs and returns `{ stopped: true }` (`src/harness/tools.ts:51-59`). The session chain, the child process, and the assignment are untouched. A model that asked to stop will believe it stopped.

### M5. Channel norms only match the English demo

**A.** T33–T34: IM ≤ 100 words, GitHub/email structured and dense. `truncateWords` splits on whitespace (`src/channels/norms.ts:2-5`). A Chinese IM message with no spaces is one word and is never cut. GitHub output is a label, a ticket id, and the same truncation at 80 words (`src/channels/norms.ts:10-12`), not headings or a checklist. `source: 'email'` is dropped on the fast path (`src/ingress/filter.ts:34-36`, covered by `test/filter.test.ts`), so an email template has no ingress. PLAN's `formatEmail` does not exist.

### M6. Assignment identity and failure attribution

**B.** `Assignments.start` uses the requested id or else the last assignment (`src/core/assignments.ts:16`). A wrong id silently starts a different row. `report` always edits `assignments.at(-1)` (`src/core/assignments.ts:32`) and does not take an assignment id. Every `kind: 'failed'` is stored as `ended.by: 'watchdog'` (`src/core/assignments.ts:50`), including a worker's own failure. Watchdog vs executor is not recoverable from the ticket.

### M7. Live model errors abort the turn and can leave it running

**B.** `HttpOpenAI.complete` has no fetch timeout (`src/harness/model.ts:164-166`). Tool arguments are `JSON.parse` with no catch (`src/harness/model.ts:210-214`); invalid JSON rejects `runTurn`, because `model.complete` sits outside the per-tool try (`src/harness/loop.ts:210`). The HTTP error string includes the first 200 characters of the response body (`src/harness/model.ts:197-199`), and `ds-agent` prints `error.message` (`src/cli/main.ts:126-128`). Combined with H6, the assignment stays `running` and the session row goes `idle`.

### M8. `report_to_router` waits on the router while holding the worker chain

**B.** The worker tool calls `engine.report` and then `await deps.routerTurn` (`src/harness/tools.ts:155-157`). `routerTurn` is chained on the router session, so today's router tools (`reply_user`, `list_tasks`) do not deadlock. `enqueue` will not run the next turn for that same worker until `report_to_router` returns (`src/harness/loop.ts:146-150`). A router tool that awaits `harness.deliver` for that ticket would wait on the worker chain that is waiting on the router. The cycle is one new tool away. Separately, `prev.then(fn, fn)` runs the next turn even when the previous one failed, and the chain pointer swallows the error (`src/harness/loop.ts:148-149`). `drain` still throws (`src/harness/loop.ts:124-126`). Callers that only `track()` and never `drain()` drop the rejection on the floor.

## Low

### L1. The error and event vocabularies drifted

`Engine.reply` throws `Error` for an unknown ticket (`src/core/engine.ts:48`). `Tickets.subscribe` throws `Error` (`src/core/tickets.ts:90`). Other engine commands throw `UserError`. PLAN's illegal-command type is `UserError`. Domain events omit `ticket.ended`, `thread.unsubscribed`, `speculate.delivered`, `speculate.discarded`, `watchdog.nudge`, and `watchdog.fail` (`src/shared/events.ts:1-11` vs PLAN line 604).

### L2. Runtime docs disagree with the package

PLAN freezes Node ≥ 20. `package.json` `engines.node` is `>=22` (this tree uses `node:sqlite`). README's quick start says Node 20+ and `pnpm start`. There is no `start` script. The database file is `ds-agent.db` (`src/store/sqlite.ts:16`), not `ds-agent.sqlite`. `node:sqlite` prints an experimental warning unless `NODE_NO_WARNINGS` is set, which the npm scripts set and a raw `node` invocation does not.

### L3. Dead helpers

`maySurface` is exported and unused (`src/speculate/gate.ts:6-9`). `Thread.correlated` is written (`src/core/intake.ts:37`) and never read. `REASONS` (`src/core/reasons.ts`) is not what `Decision.reason` stores; decisions store the strings `'accepted'` and `'speculative'`. `parseThreadKey` is not on the ingest path. Thread keys are chosen by the channel adapters before ingress (`src/channels/im.ts:14`, `src/channels/github.ts:12`).

### L4. Tests lock the log lines

`test/filter.test.ts`, `test/subscription.test.ts`, `test/spill.test.ts`, and `test/job.test.ts` plus `DEMO_PROOFS` assert substrings. They do not assert: env values absent from messages, speculative rows absent from a public list, discard with an empty outbox, a batch of more than one trigger, handback, resume creating a new assignment, watchdog fail, or the shell timeout. A green `pnpm test` is compatible with every open finding above.

## What holds

These parts match the plan and the tests:

- Obvious noise and an unknown source return `filtered` on the fast path; a long aimless note passes the fast path and drops on the keyword rules (`src/ingress/filter.ts`, `test/filter.test.ts`). Duplicate ids return `duplicate` without a second ticket.
- A second human message on a subscribed thread logs `bypass=subscription ticketId=` and does not open another ticket (`test/subscription.test.ts`). The hole is which messages qualify (H3), not the log line.
- Router tools do not include `bash`. `ToolRegistry.invoke` rejects a tool the role does not own.
- Engine writes that go through `Engine.*` run inside `Store.atomic` (`src/core/engine.ts`, `src/store/sqlite.ts:39-57`). Those methods do not await, so the transaction finishes before the next turn yields. That part of "synchronous commands" holds. The missing piece is that Eval has only one outcome (H2), and `putSpill` / session / job writes happen outside it.
- IM English text is truncated at 100 words. GitHub text is wrapped in a small labeled block (`src/channels/norms.ts`).
- SQLite document rows survive a close and a new `Store` on the same directory. The demo's restart check is that row count.
- `start_job` returns before the timer, and a later turn runs, under MockModel (`test/job.test.ts`). The later turn does not see the earlier one (H5).
- With no `DS_AGENT_API_*`, `createModelFromEnv` returns `MockModel`. With both base and key set, it returns `HttpOpenAI` (`test/filter.test.ts`). The key stays on the client object and is not copied into `systemPrompt` (`src/harness/model.ts:44-52`). Leakage is the tool path in C1, not the system prompt.

## Patch in this PR

H10 in the table above. Reproduced before the guard: `ingest` queues a worker turn, `store.close()` runs, the turn reaches `SessionJournal.append` → `Store.appendMessage`, and `node:sqlite` throws `ERR_INVALID_STATE: database is not open` (`src/store/sqlite.ts:210`). `runTurn` calls `journal.append` outside the per-tool try (`src/harness/loop.ts:205`, `213`, `228`), so the rejection escapes the turn. `Runtime.finish` closes the store after `jobsSettled`, and the CLI `finally` closes if `finish` throws (`src/cli/main.ts:41-48`, `src/cli/demo.ts:130-134`). A failed sibling turn plus `close` was enough.

The guard is local:

- `Harness.run` returns immediately when the store is already closed (`src/harness/loop.ts:154`), before `upsertSession`.
- `SessionJournal.append` still writes the JSONL line and skips SQLite when `!store.isOpen` (`src/harness/session.ts:24-25`).

`test/job.test.ts` closes the store after `ingest` and awaits `drain()`. `pnpm test` (11 tests) and `pnpm demo` passed after the change. `pnpm typecheck` passed.

C1 is not patched. A real fix is an environment allowlist, redaction of tool stdout/stderr before it is journaled or sent, a process-group kill, and the probe PLAN line 585 describes. That is a behavior change, not a crash fix. The other open findings are design gaps in the control plane; they are left as findings.

## How the running path actually looks

```
Channel adapter builds a Trigger (thread key already chosen)
  → Runtime.ingest
       filterTrigger (keyword rules for Mock and HttpOpenAI)
       on pass: spill long text, set meta.admitted, replace text with the summary
       Engine.receive
         admitted flag wins, else the same filter
         live subscription → ticket.inputs + "bypass=subscription"
         else pending
       evaluateDue → always Tickets.create → ack unless speculative
       Harness.launch: Router turn ∥ Worker turn
  Worker tools: bash (host env), read_object (full spill), start_job, report_to_router
  report_to_router → Engine.report (worker sets deliver) → another Router turn
  Watchdog.tick logs; Daemon does not resume
```

That is a scripted demo of the blog's nouns. It is not yet the dual-layer engine the plan specifies.
