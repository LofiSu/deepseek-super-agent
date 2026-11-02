# Hardening pass — 2026-11-01 (after Session D)

Scope: close the open findings in `docs/REVIEW.md` (2026-10-31) and
`docs/LIVE_CODE_REVIEW_2026-11-01.md` (Session D) against the `main` tree at
`45c6619`, then make the control-plane checks deterministic so a green suite
does not depend on which tool a live model happened to call.

Method: every finding was re-read in the tree first; each fix has a test in
`test/hardening.test.ts` unless noted. `pnpm typecheck` and the deterministic
subset pass offline (no model needed). `pnpm demo:local` was re-run against the
local Magpie gateway and reaches `demo ok (live model)`.

## Fixed

| ID | Finding | Change |
|----|---------|--------|
| C1 Critical | Untrusted `trigger.meta` admits dropped triggers and grants arbitrary spill ids | `Runtime.create` admission calls `filterTrigger` only; `Engine.receive(trigger, trust)` takes an ingress-owned `TriggerTrust` sidecar; `Intake` persists engine-authored meta only and grants spills from `trust.spillId`. `meta.admitted`/`meta.spillId` are ignored. Speculation moved to a typed `Trigger.speculate` hint that cannot admit noise. When the body was spilled, `trust.filterText` lets Intake re-admit the same redacted bytes instead of a truncated inline summary. |
| H1 High | Spill bodies stored credential values before redaction | `Runtime.ingest` redacts trigger text before `inlineOrSpill`/`putSpill`; the stored body and the prompt both see `[redacted]`. |
| H2 High | Speculative isolation is a quote-sensitive string check | `leavesWorkdir` rejects any absolute path (including after quotes inside language strings), `~`, `..`, and `$HOME`. An OS sandbox is still required for a real boundary (see below). |
| H3 High | Shell timeout signals the shell pid only; output is unbounded | `LocalEnv.bash` spawns `detached`, kills the process group with `SIGKILL` on timeout, resolves with code 124, and caps stdout/stderr (`maxOutputBytes`, default 1 MB). |
| H4 High | Router does not sequence work | `Harness.launch`/`resume` await the Router turn before the Worker starts; a new router tool `assess_trigger` can `stop` an accepted ticket and the Worker is skipped. |
| M1 | Batching is always size 1 on the real path | `RuntimeOptions.batchWindowMs`; `Runtime.flushEvals()` closes the window and `drain`/`jobsSettled`/`finish` flush it. Default 0 keeps synchronous behaviour. |
| M2 | `roleModels` absent | `DS_AGENT_ROUTER_MODEL` / `DS_AGENT_WORKER_MODEL` / `DS_AGENT_WATCHDOG_MODEL` and `RuntimeOptions.models`; `Harness` picks the model per role. |
| M3 | Watchdog residuals | A progress report is a heartbeat (`Assignment.report.at`); `nudge_worker` appends the same journal entry as `Watchdog.nudge`; a watchdog fail calls `settleSpeculation`. |
| M4 | Deliver gate keyword heuristic discards mixed reports | Clause-local verdict: a negative clause wins inside itself, a later positive clause wins overall (“could not reproduce, but fixed it” delivers). Still documented as a stand-in. |
| M5 | Two speakers on one ticket | Router prompt and `MockModel` no longer acknowledge `TICKET_CREATED`; the Engine acknowledgement is the only one. |
| M6 | Subscription predicate gaps | `contextOnly` subscriptions never bypass; a different human actor does not inherit the mandate; ended subscriptions are pruned during intake. |
| M7 | Model errors reject the turn; no fetch timeout | `HttpOpenAI` uses `AbortSignal.timeout` (`DS_AGENT_API_TIMEOUT_MS`, default 60 s) and skips malformed tool arguments instead of throwing; `runTurn` catches `model.complete` failures, journals them, and ends the turn. |
| M8 | `stop_job` does not stop the timer | The timer reads the job row first and skips a row that is no longer `running`. |
| M9 | Live suite is model-timing, not a gate | New offline `test/scripted-model.ts` + `test/hardening.test.ts` (17 tests, ~0.7 s) assert the branches above without a live model. `test/ports.test.ts` (router reply after a report) and `test/job.test.ts` (async job) now use the scripted model; the rest of the live suite remains a model-behaviour check. |
| Old REVIEW M4 | `stop_worker` reported success without stopping | `RouterPorts.stop` → `Engine.stop` → `Tickets.stop(by: 'router')`; `assess_trigger` stop and `stop_worker` use the same terminal path. |
| M10 | README overclaims | EN/zh feature lines updated: sequence point, role models, batch window, credential wording. |
| M11 | Linux CI red on a platform assumption | `test/vault.test.ts` stubs `{ platform: 'darwin', available }` instead of reading `process.platform`. |

## Still open (after the 2026-11-02 module pass)

| Item | Why it remains |
|------|----------------|
| H2/H5 true process isolation | A worker shell can still read `<stateDir>/ds-agent.db` when the OS sandbox is off. `sandbox-exec`/`bwrap` is opt-in (`DS_AGENT_SANDBOX=1`); macOS `sandbox-exec` cannot subtract a path from a read allow here, so a real boundary needs a default-deny profile or a container. PLAN §9 T51 already lists this as external. Credential values themselves no longer reach spill bodies (H1). |
| H4 full Router assessment | The deterministic Gate still defaults to `accept`; the Router can veto and now sequences the Worker, but it does not originate `accept`/`ignore` for every ordinary message. |
| M9 full deterministic suite | The pre-existing live suites still assert model tool choices. They are kept as live checks; `pnpm test` requires a model. |

Closed on 2026-11-02: T45 and T09/T46–T50 (shards, mesh, long-term memory,
lifecycle events, A2A, dual/single bake-off) are wired into the Runtime as
first-class services. See [MODULES.md](./MODULES.md). The remaining external
boundaries are the T49 panel itself and T51 host vault/seccomp.

## Verification

```text
pnpm typecheck                                    pass
offline CI mode (DS_AGENT_ALLOW_MOCK_FIXTURE=1)    195 passed, 15 skipped, 34 files
pnpm test (live Magpie, final tree)               207 passed, 3 skipped, 34 files (431.12 s)
npx vitest run test/hardening.test.ts             19 passed (~0.7 s, offline)
npx vitest run test/ports.test.ts test/job.test.ts 11 passed (~0.3 s, scripted model)
npx vitest run test/subscription.test.ts           9 passed (live Magpie, 410.7 s file time)
pnpm demo:local (live Magpie)                     demo ok (live model), 3 tickets restored
                                                  (jobsSettled outcome=deadline, as before)
```

The pre-existing live failures in `job.test.ts:24` and `ports.test.ts:205`
(both also failed on the 45c6619 baseline) are gone because those two tests now
drive the protocol with `ScriptedModel`. `pnpm demo:local` still reports
`jobsSettled outcome=deadline` because a live model keeps scheduling tools past
the demo's 45 s cap; the demo exits 0.
