# Plan audit and living roadmap

> Status: living document · First audit: 2026-11-02 against `8f8e104` ·
> Revised: 2026-11-02 against `7f1c9a1` · Repo: `LofiSu/deepseek-super-agent`
>
> Sources for current-state claims: `origin/main` at `7f1c9a1` (`PLAN.md`,
> `README.md`, `README.zh-CN.md`, `docs/install.md`, `docs/zh/install.md`,
> `docs/MODULES.md`, `docs/HARDENING_2026-11-01.md`), `src/`, `test/`,
> `package.json`, `.github/workflows/ci.yml`, and the `gh` PR history.
>
> This file is **read-only evidence plus a plan**. It does not edit `PLAN.md`,
> `README.md`, `README.zh-CN.md`, or `docs/MODULES.md`.

## Revision history

| Date | Base | Change |
|------|------|--------|
| 2026-11-02 | `8f8e104` (#37) | Initial audit of the frozen `45c6619` tree plus its uncommitted refactor. |
| 2026-11-02 | `a38ea81` (#41) | Rebased after #40 and #41 merged; P0-1/P0-2 narrowed. |
| 2026-11-02 | `7f1c9a1` (#44) | Rebased again after #44, #46, and #51 merged; P0-1/P0-2/P0-3 resolved, P1-8 resolved, and all current-state claims re-audited. |

PR history correction: the audit base `8f8e104` is **#37** (GitHub Pages).
**#38** (`566d308`, opt-in domain naming) merged just before it. The refactor is
**#40** (`4b919bd`), README/PLAN alignment is **#41** (`a38ea81`), the
`MODULES.md` runner fix is **#46** (`0d9ec20`), the remaining opt-in reference
cleanup is **#51** (`3e04e82`), and the fail-closed sandbox is **#44**
(`7f1c9a1`). #42 (`f036790`) is the Mermaid docs fix. There were no open PRs
when the initial audit started.

## 0. What changed since the first audit

The first audit described a detached `45c6619` tree with a 64-file uncommitted
refactor. **That refactor has merged as #40 (`4b919bd`).** On current `main`:

- `src/phase2/` does not exist.
- The services live in their owning modules:
  `src/ingress/shards.ts` (Router shards), `src/harness/mesh.ts` (Worker mesh),
  `src/memory/long-term.ts` (long-term memory), `src/core/lifecycle.ts`
  (lifecycle events), `src/channels/a2a.ts` (A2A).
- `docs/MODULES.md` and `docs/HARDENING_2026-11-01.md` are tracked.
- `PLAN.md`, both READMEs, both install pages, and the review-method docs no
  longer describe a `DS_AGENT_PHASE2` master switch (fixed by #41 and #51).
- The tracked-tree grep for
  `DS_AGENT_PHASE2|runtime.phase2|ProductShellBus|src/phase2` has only the two
  intentional negations in `PLAN.md:883,1056`.
- The filesystem sandbox is now **default-on and fail-closed** (#44): a missing
  `sandbox-exec`/`bwrap` throws instead of silently running unsandboxed bash.
  Documentation still says the old opt-in flag (C15).

The §2/§3 matrices keep audit-time observations where useful, but every
**current-state** claim below was re-checked against `7f1c9a1`.

## 1. Status legend

| Mark | Meaning |
|------|---------|
| **done** | Implemented on the default path, with at least one test that exercises it offline. |
| **partial** | Implemented but thin, heuristic, or not enforced on every path. |
| **missing** | No implementation, or only a stub. |
| **external boundary** | Deliberately outside this repo; documented with an interface and a reason. |

Evidence points at a source file **and** a test file. A log substring alone is
not evidence (see `docs/CODE_REVIEW_METHOD.md`).

## 2. Module status matrix (M0–M11)

| Module | Status | Evidence | Gap |
|--------|--------|----------|-----|
| **M0 shared** | done | `src/shared/types.ts`, `ports.ts`, `events.ts`, `boundary.ts`; `test/ports.test.ts`; `npx tsc --noEmit` passes | `PLAN.md` §4 still freezes old shapes: `SessionRole` (`PLAN.md:280`) vs `Role` (`src/shared/types.ts:1`), `Assignment.status` (`PLAN.md:342`) vs `Assignment.state` (`src/shared/types.ts:104`), and a `Harness.injectJobResult` (`PLAN.md:538`) that does not exist. `PLAN.md` §10 lists files that do not exist. This is P0-4. |
| **M1 harness** | done | `src/harness/loop.ts` (Router-before-Worker sequence at `145-160`, async jobs, batch window), `session.ts`, `model.ts`, `tools.ts`, `daemon.ts`, `machines.ts`, `team.ts`, `mesh.ts`; `test/job.test.ts`, `team-harness.test.ts`, `daemon-machines.test.ts`, `hardening.test.ts`, `live-modules.test.ts` | No standalone `serve` daemon: `Daemon.start()` is an in-process timer; an in-flight turn is not reconstructed after restart. `PLAN.md` §5 M1 asks for process keepalive and resume of unfinished Session/Jobs. This is P1-6. |
| **M2 store** | done | `src/store/sqlite.ts` (`node:sqlite` at `:3`, `ds-agent.db` at `:16`), `schema.ts`, `spill.ts`, document/spill upsert; `test/spill.test.ts`, `long-term-memory.test.ts`, `live-modules.test.ts` (reopen) | No migration/version table; `node:sqlite` is experimental and needs Node ≥22. `PLAN.md` §10 names `db.ts`/`repos.ts`/`migrate.ts`, which do not exist (P0-4). |
| **M3 engine** | partial | `src/core/engine.ts`, `intake.ts`, `evals.ts`, `tickets.ts`, `assignments.ts`, `replies.ts`, `subscribe.ts`, `collab.ts`, `lifecycle.ts`, `assessment.ts`; `test/subscription.test.ts`, `speculate.test.ts`, `mid-task-collab.test.ts`, `hardening.test.ts`, `live-modules.test.ts` | The deterministic Gate still defaults to `accept` (`src/core/assessment.ts:31-41`). The Router can veto through `assess_trigger`, but it does not originate `ignore`/`unavailable` for ordinary messages. This is the remaining half of old H4 and part of T06; PR #39 is rebasing the domain alignment work. This is P1-2. |
| **M4 ingress** | partial | `src/ingress/filter.ts`, `shards.ts`, `thread.ts`, `batch.ts`; `test/filter.test.ts`, `router-shards.test.ts`, `runtime-integration.test.ts` | Fast Path is source + mention + keyword + noise; no actor allowlist, group/chat allowlist, or drop-self (old H8 residue). Slow Path is `ruleClassify` for both Mock and `HttpOpenAI` (`src/harness/model.ts:167-169`); it does **not** call the live model, contrary to `README.md:64` (C8). |
| **M5 subscribe** | done | `src/core/subscribe.ts`, `intake.ts` fan-out; `test/subscription.test.ts`, `hardening.test.ts` (contextOnly, unsubscribe) | `handback` is not exposed as a CLI action. The tests cover unsubscribe but not the full requeue-and-drop lifecycle as an operator flow. |
| **M6 memory** | partial | `src/memory/recall.ts`, `acl.ts`, `long-term.ts`; `test/spill.test.ts`, `long-term-memory.test.ts`, `live-modules.test.ts` | Recall is word-AND substring matching over a spill, not semantic or multi-hop. No retention policy or size cap for the `ltm` table. `README.md:115` admits "not month-scale"; the code matches that partial claim. |
| **M7 speculate** | done | `src/speculate/silent.ts`, `gate.ts`; `test/speculate.test.ts`, `live-modules.test.ts`, `hardening.test.ts` | The gate is a clause-local keyword heuristic, documented as a stand-in (`docs/HARDENING_2026-11-01.md:25`). It is not a model verdict; a real value judgment remains open. |
| **M8 channels** | done | `src/channels/norms.ts`, `cli.ts`, `feishu.ts`, `github-source.ts`, `outbox-adapter.ts`, `a2a.ts`; `test/channels-feishu.test.ts`, `channels-github-source.test.ts`, `outbox.test.ts`, `lifecycle-a2a.test.ts`; real demos in `src/cli/demos/*` | Real-channel acceptance is operator-only: `test/demos-real-channels.test.ts` is skipped offline (3 tests), and `pnpm demo` needs `gh auth` plus a live model. There is no email adapter (the plan calls it optional). |
| **M9 env** | partial | `src/env/local-env.ts`, `sanitize.ts`, `vault.ts`, `seccomp.ts` (`sandboxEnabledFromEnv` returns true); `test/sanitize.test.ts`, `vault.test.ts`, `hardening.test.ts`, `local-env-timeout.test.ts`, `live-modules.test.ts` | #44 made the sandbox default-on and fail-closed: a missing `sandbox-exec`/`bwrap` throws. Host vault/seccomp policy is still external, and the docs still describe the old `DS_AGENT_SANDBOX=1` opt-in (C15, P1-10). Credential redaction is tested for spill bodies, not every session/prompt path (P0-5). |
| **M10 watchdog** | partial | `src/watchdog/watchdog.ts`, `rules.ts`, `rules.json`, `health.ts`; `test/health.test.ts`, `daemon-machines.test.ts`, `live-modules.test.ts`, `hardening.test.ts` | Goal-drift detection is marker-based ("a running report that says it left the scope"), not a general NL comparison. `PLAN.md` T43–T44 ask for NL rules; `README.md:100` already calls this "thin". |
| **M11 CLI / demo** | partial | `src/cli/main.ts` (init/tasks/status/health/chat/emit/metrics/memory/a2a/pause/intervene/resume/collab/team/teams), `src/cli/demos/run.ts`, `src/cli/bakeoff.ts`; `test/cli-memory-a2a.test.ts`, `mid-task-collab.test.ts`, `live-demo.test.ts`, `live-e2e.test.ts` | `pnpm demo` (real GitHub issues/comments) is not in CI and needs an operator with `gh auth`. `package.json` has no `bin`, no `build`, and `tsconfig` is `noEmit`, so the `PLAN.md` §10 `dist/cli.js` bin does not exist. No `serve` command. The `MODULES.md` runner claim is fixed by #46. |

## 3. Functional-domain matrix (PLAN §9)

| Domain | Status | Evidence | Gap |
|--------|--------|----------|-----|
| **评测与指标** (T45) | done | `src/metrics/metrics.ts`, `curve.ts`, `bakeoff.ts`, `batching-bench.ts`; `src/cli/bakeoff.ts`; `test/metrics.test.ts`, `metrics-curve.test.ts`, `batching-bench.test.ts`, `runtime-integration.test.ts` | Counters, `curveSamples`, `model.call`, `compareBakeoff`, and `pnpm bench:bakeoff` exist. A live bake-off is a manual measurement (needs a model key); it is not a CI gate. `docs/MODULES.md:179` claims 207 passed / 3 skipped on a live Magpie run; unverified in this audit (P1-9). |
| **扩展** — Router shards (T46) | done | `src/ingress/shards.ts`; `Disposition.shards` in `src/shared/types.ts:85-91`; `Runtime.create` registers `DS_AGENT_SHARDS` (`src/runtime.ts:151-166`); `Harness.launch` runs one Router session per shard (`src/harness/loop.ts:74-77,145-160`); `test/router-shards.test.ts`, `runtime-integration.test.ts` | Arbitration between multiple matching shards is undefined: every shard turn runs, and a stop ends the ticket, but two shards can both call `reply_user`. Add a documented precedence/merge rule and a test (P2-2). |
| **扩展** — Worker mesh (T47) | partial | `src/harness/mesh.ts`; `Assignment.node` in `src/shared/types.ts:102-120`; placement event in `src/harness/loop.ts:84-89,129-141`; `test/worker-mesh.test.ts`, `runtime-integration.test.ts` | Placement is logical and single-process. When capacity is full, `launch` logs `node=none capacity-full` and still runs the Worker; there is no queue, rejection, or backpressure. Cross-host transport is external, which is acceptable, but capacity enforcement is not. This is P1-3. |
| **长期记忆** (T48) | partial | `src/memory/long-term.ts`; write on terminal ticket in `src/runtime.ts:201-216`; recall injection in `src/runtime.ts:274-282`; `test/long-term-memory.test.ts`, `runtime-integration.test.ts` | One redacted entry per ticket, keyword AND recall, three results. No retention, dedupe beyond per-ticket upsert, semantic search, or month-scale story. Documented as partial in `README.md:115`; keep it that way until the scale work lands (P2-1). |
| **产品层** (T49) | external boundary + partial | `src/core/lifecycle.ts` (`LifecycleBus`, `subscribe`, `snapshot`); lifecycle publishing in `src/runtime.ts:190-216,432-469`; `ds-agent memory` / `ds-agent a2a` in `src/cli/main.ts:204-231`; `test/lifecycle-a2a.test.ts`, `cli-memory-a2a.test.ts`, `runtime-integration.test.ts` | The in-repo contract is done; the actual panel is another repository (PLAN §9 T49). The bus is in-memory and unbounded: `LifecycleBus.history` grows without a cap and does not survive restart, so a panel cannot replay an earlier process. Bound it and/or persist events (P1-4). |
| **互操作** (T50) | external boundary + partial | `src/channels/a2a.ts`; `Runtime.sendA2A` and local recipient in `src/runtime.ts:319-328,390-395`; `test/lifecycle-a2a.test.ts`, `runtime-integration.test.ts` | Validation, 64 KiB cap, persistence, `delivered\|unroutable\|failed`, and a filtered `a2a` Trigger exist. There is no cross-process transport and no authentication; an adapter must add both. Document the adapter contract and never expose the local endpoint unauthenticated (P1-5). |
| **安全与隐私** (T51) | external boundary + partial | `src/env/sanitize.ts` (allowlist, secret redaction), `vault.ts`, `seccomp.ts`; `test/sanitize.test.ts`, `vault.test.ts`, `hardening.test.ts`, `local-env-timeout.test.ts` | In-repo: env allowlist, spill redaction, `[redacted]` output, FileVault names only, default-on fail-closed OS sandbox (#44), spill ACL, untrusted `meta` rejection. External: host-level vault/seccomp and true host isolation. Sandbox docs still describe the old opt-in (C15); credential probes are incomplete (P0-5). |

## 4. Definition of done (the whole project)

The project can be called complete only when **all** of these are true.

### 4.1 Code

1. `origin/main` contains the M0–M11 implementation. True via #40.
2. No code reads `DS_AGENT_PHASE2`, `runtime.phase2`, or `ProductShellBus`.
   True; only the two explicit negations in `PLAN.md:883,1056` remain.
3. Every target from PLAN §3 (T01–T51) is either implemented with a source
   pointer or explicitly marked external in PLAN/README/MODULES.
4. No open Critical/High finding from `docs/REVIEW.md` remains unclassified.
   Each is fixed, downgraded with evidence, or listed as an external boundary.
5. `PLAN.md` §4 interfaces and §10 file tree match `src/shared` and the real
   tree, or the contract is rewritten to say it is a design sketch. **Open:
   P0-4.**
6. The build/package story is decided: either a working `build` + `bin` +
   `dist`, or an explicit "source-only via `pnpm`/`tsx`" statement in README and
   `package.json`. **Open: P1-7.**

### 4.2 Tests

1. Offline PR gate: `pnpm typecheck` + `DS_AGENT_ALLOW_MOCK_FIXTURE=1 pnpm test`
   green, with no live key, on every PR. New domain tests must run, not skip.
2. Live reference run: `pnpm test` green on a documented model/gateway, with the
   date, model id, pass/skip counts, and transcript path recorded.
   `docs/MODULES.md:179` claims 207 passed / 3 skipped; reproduce it (P1-9).
3. Real-channel acceptance: `pnpm demo` (real GitHub issues + comments) and
   `pnpm demo:feishu` run on a release candidate, with artifacts under
   `/tmp/ds-agent-live-e2e-logs/`. A green offline suite is not a substitute.
4. Security probes are automated: a sentinel credential value must not appear in
   any session event, prompt, tool result, spill, or journal; a Worker call to
   `reply`/`decide`/`receive` must throw; a speculative ticket must be absent
   from `visibleTickets` until the gate delivers. **Open: P0-5.**
5. Capacity and failure paths have tests: mesh capacity-full behavior, A2A
   failure, shard arbitration, batch > 1, watchdog fail, resume after restart.

### 4.3 Docs

1. `PLAN.md`, `README.md`, `README.zh-CN.md`, `docs/install.md`,
   `docs/zh/install.md`, `docs/MODULES.md`, `docs/safety.md`, and this roadmap
   agree with the code.
2. `git grep -nE "DS_AGENT_PHASE2|runtime\.phase2|ProductShellBus|src/phase2"` on
   `origin/main` returns only the two explicit negations in `PLAN.md`.
3. Status marks are honest: `[x]` only for a path covered by a test or a real
   operator run; `[~]` for partial; `[ ]` for missing. External boundaries say
   "external", not "done".
4. `docs/MODULES.md` is tracked on `main` and its links work.

### 4.4 CI

1. The PR job runs typecheck + offline tests and is a required check.
2. An opt-in live job runs when `DEEPSEEK_API_KEY`/`DS_AGENT_API_KEY` is present;
   it must fail, not silently skip, when the key exists and the model is broken.
3. A `workflow_dispatch` real-channel job (or a documented release checklist
   with evidence) runs `pnpm demo` with a scoped `gh` token and uploads logs.
4. Branch protection requires the offline gate; no critical test uses
   `continue-on-error`.

### 4.5 External boundaries (explicitly out of scope)

These must be documented as external, with an interface and a security note:

- T49 panel UI (another repo).
- T51 host-level vault/seccomp and true host isolation.
- A2A cross-process transport and authentication.
- Multi-host Worker mesh transport.
- Managed credential storage / cloud executor.

## 5. Documentation contradictions

Status is against current `main` (`7f1c9a1`). Resolved rows are kept so readers
can see what changed.

| # | Claim | Location at audit time | Current reality | Status |
|---|-------|------------------------|-----------------|--------|
| C1 | Extension domains are off by default; enable with `DS_AGENT_PHASE2=1` / `RuntimeOptions.phase2`; registries live on `runtime.phase2`. | `PLAN.md:883,888-892,1056`; `README.md:37,53,302-305`; `README.zh-CN.md:37,53`; `docs/install.md:62`; `docs/zh/install.md:63` | Services are constructed unconditionally (`src/runtime.ts:151-170`); `RuntimeOptions` has no `phase2` field (`src/runtime.ts:36-61`). `PLAN.md:883,1056` now state the switch is gone; README/install were cleaned by #41/#51. | resolved (#40, #41, #51) |
| C2 | `src/phase2` contains the extension helpers. | `README.md:302` | `src/phase2/` is deleted. Replacements: `src/ingress/shards.ts`, `src/harness/mesh.ts`, `src/memory/long-term.ts`, `src/core/lifecycle.ts`, `src/channels/a2a.ts`. | resolved (#40, #41) |
| C3 | Router sharding is opt-in and "Runtime wires only when `DS_AGENT_PHASE2=1`"; T09 is a future gap. | `PLAN.md:228,1044`; `README.md:53` | Shards are wired on every run: `Runtime.create` registers `DS_AGENT_SHARDS` (`src/runtime.ts:151-166`), `ingest` stores `Disposition.shards` (`src/runtime.ts:362`), and `Harness.launch` runs one Router session per shard (`src/harness/loop.ts:74-77,145-160`). | resolved (#40, #41) |
| C4 | `ProductShellBus` exists as an opt-in shell. | `PLAN.md:268`; `README.md:58,116`; `README.zh-CN.md:58,112` | No `ProductShellBus`. The in-repo read model is `LifecycleBus` (`src/core/lifecycle.ts:11`), always constructed (`src/runtime.ts:169`). The panel itself is still external. | resolved (#40, #41) |
| C5 | Worker mesh, long-term memory, and A2A are opt-in and "not consulted by admission or the harness loop". | `README.md:114-118,302`; `PLAN.md:889-892` | `pickNode` is called in `Harness.launch` (`src/harness/loop.ts:84`); `SpillBackedLongTermMemory.remember/query` is called on ticket end and launch (`src/runtime.ts:201,274`); `A2ARouter` is registered as a local recipient (`src/runtime.ts:319`). | resolved (#40, #41) |
| C6 | The full dual-layer vs one-Session bake-off is still open. | `README.md:107` | `compareBakeoff` (`src/metrics/bakeoff.ts`) and `pnpm bench:bakeoff` (`src/cli/bakeoff.ts`) exist; `test/metrics-curve.test.ts` and `test/runtime-integration.test.ts:194-217` cover the code path. What remains is the live measurement. | remaining (wording) |
| C7 | T45 "计数已做；端到端曲线未做". | `PLAN.md:1053` | `curveSamples` persist in `metrics.json` and are summarized by `summarizeCurve` (`src/metrics/curve.ts`); `test/metrics-curve.test.ts` covers persistence, legacy files, and percentiles. | resolved (#40) |
| C8 | Slow Path "can call a model". | `README.md:64`; `README.zh-CN.md:64` | Both `MockModel.classify` and `HttpOpenAI.classify` call `ruleClassify` (`src/harness/model.ts:89,167`; `src/ingress/filter.ts`). No admission decision is sent to the model. | remaining |
| C9 | Tests default to `MockModel`. | `PLAN.md:50` | The default suite refuses `MockModel`: `test/fixtures.ts:11-24` throws unless `DS_AGENT_ALLOW_MOCK_FIXTURE=1`; `README.md:235` documents the live requirement. | remaining |
| C10 | Runtime is Node ≥20. | `PLAN.md:48` | `package.json:8-10` requires Node ≥22; `src/store/sqlite.ts:3` uses `node:sqlite`. | remaining |
| C11 | Real Feishu/GitHub sources are out of scope before M11. | `PLAN.md:39-40` | M8 ships `src/channels/feishu.ts` (webhook parser + polling source) and `src/channels/github-source.ts`; `README.md:275-298` makes real channels the acceptance path. | remaining (stale boundary table) |
| C12 | PLAN §4 freezes `SessionRole`, `Assignment.status`, and a `Harness.injectJobResult` API that the code does not have. | `PLAN.md:280,342,538` | `src/shared/types.ts:1` defines `Role`; `:5` adds `maybe` to `Strength`; `:104` uses `Assignment.state`; no `injectJobResult`. | remaining (P0-4) |
| C13 | `docs/MODULES.md` says `src/cli/demo.ts` drives the real-channel acceptance scenarios. | `docs/MODULES.md:140-141` | `pnpm demo` points at `src/cli/demos/run.ts`; `src/cli/demo.ts` is the offline fixture baseline. Fixed by #46. | resolved (#46) |
| C14 | PLAN says the DB is `better-sqlite3` or `node:sqlite` in `ds-agent.sqlite`. | `PLAN.md:49` | `src/store/sqlite.ts:3,16` uses `node:sqlite` and `ds-agent.db`. | remaining (minor, P0-4 scope) |
| C15 | The OS sandbox is opt-in via `DS_AGENT_SANDBOX=1`, and bash falls back to unsandboxed execution when the wrapper is missing. | `README.md:119`; `README.zh-CN.md:115`; `docs/MODULES.md:126`; `docs/safety.md:29,31`; `docs/zh/safety.md:30,32`; `docs/HARDENING_2026-11-01.md:39`; `docs/LIVE_CODE_REVIEW_2026-11-01.md:130,185` | #44 made sandboxing default-on and fail-closed: `sandboxEnabledFromEnv` returns true and `wrapBashCommand` throws if `sandbox-exec`/`bwrap` is missing. Explicit `enabled: false` is only a test/embedding opt-out. | remaining (P1-10) |

Doc hygiene, not false claims:

- `PLAN.md` §10 still lists `src/app/runtime.ts`, `ids.ts`, `roles.ts`,
  `jobs.ts`, `db.ts`, `repos.ts`, `migrate.ts`, `part.ts`, `policy.ts`,
  `fast-path.ts`, `slow-path.ts`, `inline.ts`, `spill-bridge.ts`,
  `read-object.ts`, `graph.ts`, `local.ts`, `prepare.ts`, `timer.ts`,
  `detect.ts`, and `actions.ts`. None exist. Update the tree or mark it
  illustrative (P0-4).
- `docs/REVIEW.md`, `docs/LIVE_CODE_REVIEW_2026-11-01.md`, and
  `docs/ARCHITECTURE_REVIEW.zh.md` are snapshots. `ARCHITECTURE_REVIEW.zh.md`
  now has a status note via #51; the other two should get the same banner.

## 6. Ranked gaps

### Resolved since the first audit

**P0-1. Land the refactor — resolved by #40 (`4b919bd`).**
`src/phase2/` is gone, the new services and tests are tracked, and
`docs/MODULES.md` + `docs/HARDENING_2026-11-01.md` are on `main`.

**P0-2. Remove the stale opt-in documentation — resolved by #41 (`a38ea81`)
and #51 (`3e04e82`).**
`PLAN.md` and both READMEs were aligned in #41; `docs/install.md:62`,
`docs/zh/install.md:63`, `docs/ARCHITECTURE_REVIEW.zh.md:7,17`, and
`docs/CODE_REVIEW_METHOD.md:52` were fixed in #51. The only remaining matches
are the two explicit negations in `PLAN.md:883,1056`.

**P0-3. Put `docs/MODULES.md` on `main` and fix the runner claim — resolved by
#46 (`0d9ec20`).**
The file is tracked and points at `src/cli/demos/run.ts`. Test-count
reproducibility moved to P1-9.

**P1-8. Fail closed when no filesystem sandbox is available — resolved by #44
(`7f1c9a1`).**
`sandboxEnabledFromEnv` is true by default and `wrapBashCommand` throws when the
platform wrapper is missing; CI installs `bubblewrap`. The remaining work is
documentation (P1-10), not enforcement.

### P0 — top open gaps

**P0-4. Re-freeze the interface contract (unchanged).**
Status: open, in progress.
Evidence: `PLAN.md:280` freezes `SessionRole`; `PLAN.md:342` freezes
`Assignment.status`; `PLAN.md:538` freezes `Harness.injectJobResult`;
`src/shared/types.ts:1` defines `Role`, `:5` adds `maybe`, `:104` uses
`Assignment.state`, and no `injectJobResult` exists. `PLAN.md:49` also names
`better-sqlite3`/`ds-agent.sqlite`, while the code uses `node:sqlite` and
`ds-agent.db`. `PLAN.md` §10 lists files that do not exist.
Acceptance: PLAN §4 either matches `src/shared/types.ts`/`ports.ts` or is
renamed "illustrative"; §10 matches the real tree; `npx tsc --noEmit` stays
green; a short contract test or doc check catches future drift.
Suggested workstream: docs + shared-module owner, new branch
`docs/re-freeze-contract`.

**P0-5. Prove credential non-leakage on every path (unchanged).**
Status: open, in progress.
Evidence: `test/hardening.test.ts:73-86` proves spill-body redaction; the plan's
D13 probe asks for prompt/session assembly. `LocalEnv` redacts stdout/stderr and
the Logger redacts, but there is no single sentinel test across store messages,
journal, tool results, and model requests.
Acceptance: one offline test sets a sentinel key, runs a worker that echoes it,
and asserts the sentinel is absent from every `store.listMessages`, JSONL
journal line, tool result, and captured model request. Also assert `WorkerPorts`
rejects `reply`/`decide`/`receive`.
Suggested workstream: security agent, new branch `test/credential-probes`.

### P1 — needed for a defensible "complete"

**P1-1. Automate or formally checklist the real-channel acceptance.**
Status: operator-only. `test/demos-real-channels.test.ts` skips 3 tests offline;
`.github/workflows/ci.yml` runs `pnpm demo:local` (fixture smoke), not
`pnpm demo`.
Acceptance: a `workflow_dispatch` job (or a release checklist with attached
logs) runs `pnpm demo` with a scoped `gh` token and a model key, uploads
`/tmp/ds-agent-live-e2e-logs/demos/`, and fails on a missing provider comment id.
Suggested workstream: CI/release agent, new branch `ci/real-channel-acceptance`.

**P1-2. Finish the Router assessment or downgrade the claim.**
Status: open. PR #39 (`fix/domain-alignment-article`) is rebasing and targets
Eval/Subscription/Mandate alignment. The Gate still accepts by default
(`src/core/assessment.ts:31-41`); the Router can only veto.
Acceptance: either the Router can emit `ignore`/`accept`/`unavailable` for
ordinary triggers with a test, or PLAN T06/§2.3 and README say "Gate accepts;
Router vetoes" and remove the stronger claim.
Suggested workstream: harness agent + PR #39 author.

**P1-3. Enforce mesh capacity.**
Status: open. `src/harness/loop.ts:84-89` logs `capacity-full` and still runs.
Acceptance: a test proves one of: the ticket queues until a slot frees, or it is
rejected with a domain event/outcome. Choose one and document it in MODULES.
Suggested workstream: harness agent, `feat/mesh-backpressure`.

**P1-4. Make the lifecycle read model replayable.**
Status: open. `LifecycleBus.history` is unbounded and in-memory
(`src/core/lifecycle.ts`).
Acceptance: a bounded ring buffer plus optional SQLite persistence, or an
explicit "current-process only" note in MODULES and the T49 row; snapshot
survives a restart if persistence is chosen.
Suggested workstream: product/engine agent, `feat/lifecycle-persistence`.

**P1-5. Define the A2A adapter contract and authentication note.**
Status: open. In-process only (`src/channels/a2a.ts`).
Acceptance: an exported `A2ATransport` interface (send/receive) and a test
double; MODULES states that an adapter must authenticate the peer before
constructing a human Trigger. Do not expose the local endpoint unauthenticated.
Suggested workstream: interop agent, `feat/a2a-transport`.

**P1-6. Standalone daemon / `serve` and in-flight resume.**
Status: open. `Daemon` is an in-process timer; no `serve` command; no in-flight
turn reconstruction.
Acceptance: `ds-agent serve` starts the timer, handles SIGTERM, and resumes
unfinished jobs/sessions from SQLite; or PLAN M1/M11/T38–T40 are downgraded to
"scheduler only" and README says so.
Suggested workstream: harness agent, `feat/daemon-serve`.

**P1-7. Decide the packaging story.**
Status: open. `package.json` has no `bin`, no `build`; `tsconfig` is `noEmit`.
PLAN §10 promises `bin: dist/cli.js`.
Acceptance: either `pnpm build` emits `dist/cli.js` and `npm pack` exposes the
`ds-agent` bin, or PLAN/README state "source-only, run with `pnpm ds-agent`".
Suggested workstream: release agent, `chore/packaging`.

**P1-9. Reproduce the live reference run.**
Status: open. `docs/MODULES.md:179` claims 207 passed / 3 skipped on a live
Magpie run (431.12 s). This audit has no live key and did not reproduce it. The
offline CI gate reports 196 passed / 15 skipped / 35 files on `7f1c9a1`.
Acceptance: a dated live run with the model id, pass/skip counts, and transcript
path; update `docs/MODULES.md` if the number changes.
Suggested workstream: release agent, `ci/live-reference-run`.

**P1-10. Correct the sandbox documentation after #44.**
Status: open. The code is default-on/fail-closed, but the docs still describe
`DS_AGENT_SANDBOX=1` as an opt-in and say bash falls back unsandboxed.
Evidence: `README.md:119`, `README.zh-CN.md:115`, `docs/MODULES.md:126`,
`docs/safety.md:29,31`, `docs/zh/safety.md:30,32`,
`docs/HARDENING_2026-11-01.md:39`, `docs/LIVE_CODE_REVIEW_2026-11-01.md:130,185`
(the last three are historical snapshots; add a status note rather than rewrite
history).
Acceptance: user-facing docs say sandboxing is default-on and fails closed when
`sandbox-exec`/`bwrap` is absent; explicit opt-out is described as test/embedding
only; the historical reviews get a status note.
Suggested workstream: docs agent, `docs/sandbox-defaults`.

### P2 — quality and scale

**P2-1. Long-term memory scale:** retention/size cap, dedupe policy, and a
semantic or tag+recency ranking. Acceptance: a test with >N entries proves the
cap; MODULES documents the recall formula.
**P2-2. Shard arbitration:** define precedence and reply ownership when multiple
shards match; add a test. Acceptance: at most one terminal decision per trigger
unless explicitly documented.
**P2-3. Fast-path allowlists:** actor/group/drop-self rules from T16;
acceptance: `test/filter.test.ts` covers each rule.
**P2-4. Slow-path live policy:** optional model policy behind a flag, or keep
the rule classifier and remove "can call a model" from README. Acceptance: one
of the two is true and tested.
**P2-5. Test coverage and lint:** add a coverage report and a lint/format script
to CI; acceptance: thresholds documented, not necessarily enforced.
**P2-6. Repo hygiene:** confirm the untracked `repro-h9*.ts` diagnostics are
gone from `main`; acceptance: `git status` clean after merge.
**P2-7. Doc snapshots:** add the "historical" banner to `docs/REVIEW.md` and
`docs/LIVE_CODE_REVIEW_2026-11-01.md` (the zh architecture review already has
one via #51).
**P2-8. Email channel:** either implement `formatEmail` + an email source or
remove the optional mention from PLAN §3/T34. Acceptance: PLAN and code agree.

## 7. Dynamic task board

Owner stays empty where no agent is assigned. PR/branch cells are filled where
the work is already public.

| ID | Task | Owner | Branch | PR | Status | Acceptance |
|----|------|-------|--------|----|--------|------------|
| P0-1 | Land refactor + MODULES/HARDENING |  | `refactor/m0-m11-modules` | #40 (`4b919bd`) | resolved | Merged; `src/phase2` gone; domain tests run in CI |
| P0-2 | Remove stale opt-in docs |  | `docs/module-boundaries` | #41 (`a38ea81`), #51 (`3e04e82`) | resolved | Only the two explicit negations in `PLAN.md` remain |
| P0-3 | Fix `MODULES.md` demo runner |  | `docs/m11-demo-runner-fix` | #46 (`0d9ec20`) | resolved | Points at `src/cli/demos/run.ts` |
| P0-4 | Re-freeze PLAN §4/§10 contract |  |  |  | in progress | Plan matches `src/shared` and the real tree, or says illustrative; typecheck green |
| P0-5 | Credential sentinel test across store/journal/prompt/tool |  |  |  | in progress | Sentinel absent everywhere; Worker port calls throw |
| P1-1 | Real-channel acceptance job/checklist |  |  |  | todo | `workflow_dispatch` or release evidence for `pnpm demo` + Feishu |
| P1-2 | Router assessment / domain alignment |  | `fix/domain-alignment-article` | #39 | in progress (rebasing) | Router originates decisions, or docs say veto-only |
| P1-3 | Mesh capacity enforcement |  |  |  | todo | Queue or reject on capacity-full, with test |
| P1-4 | Lifecycle replayability |  |  |  | todo | Bounded/persisted bus or explicit current-process note |
| P1-5 | A2A transport interface + auth note |  |  |  | todo | `A2ATransport` + test double; auth requirement documented |
| P1-6 | `ds-agent serve` + in-flight resume |  |  |  | todo | Serve works, SIGTERM clean, resume tested, or docs downgraded |
| P1-7 | Packaging decision |  |  |  | todo | Working `bin`/`build`, or explicit source-only note |
| P1-8 | Fail-closed filesystem sandbox |  | `fix/env-fail-closed-sandbox` | #44 (`7f1c9a1`) | resolved | Missing wrapper throws; CI installs `bubblewrap` |
| P1-9 | Reproduce live reference run |  |  |  | todo | Dated live run matches `MODULES.md:179` or updates it |
| P1-10 | Correct sandbox docs to default-on/fail-closed |  |  |  | todo | User docs no longer describe `DS_AGENT_SANDBOX=1` opt-in |
| P2-1 | LTM retention/ranking |  |  |  | todo | Cap + recall formula test |
| P2-2 | Shard arbitration |  |  |  | todo | Precedence documented + test |
| P2-3 | Fast-path allowlists |  |  |  | todo | Actor/group/drop-self tests |
| P2-4 | Slow-path policy vs claim |  |  |  | todo | Code or README changed, tested |
| P2-5 | Coverage + lint in CI |  |  |  | todo | Scripts exist; policy documented |
| P2-6 | Confirm `repro-h9*.ts` removed |  |  |  | todo | Root clean |
| P2-7 | Status banners on review snapshots |  |  |  | todo | Historical banner on each |
| P2-8 | Email channel decision |  |  |  | todo | PLAN and code agree |
| R-1 | This audit | planning-review agent | `docs/roadmap` | #43 | in review | File merged; board updated when gaps move |

## 8. Verification log

### Audit-time (historical)

Run on the frozen tree at `45c6619` plus its uncommitted refactor, Node
`v22.23.4`, pnpm `9.15.9`:

```text
npx tsc --noEmit                                      pass
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run  195 passed, 15 skipped, 34 files, 2.32 s
```

### Current main (`7f1c9a1`, rebased PR head)

```text
npx tsc --noEmit                                      pass
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run  196 passed, 15 skipped, 35 files, 2.04 s
```

CI run `41381516075` on `7f1c9a1` reports the same offline counts
(196 passed / 15 skipped / 35 files). Earlier runs: `a38ea81`
(run `41380824017`) and `4b919bd` (run `41380704034`) report
195 passed / 15 skipped / 34 files, before #44 added
`test/local-env-timeout.test.ts`.

The 15 skipped tests are the live/real-channel suites:
`demos-real-channels.test.ts` (3), `live-demo.test.ts` (3), `live-e2e.test.ts`
(7), `team-live.test.ts` (2). `live-modules.test.ts` runs under
`DS_AGENT_ALLOW_MOCK_FIXTURE=1` and passed.

`docs/MODULES.md:179` claims a **live** Magpie run of 207 passed / 3 skipped
(431.12 s). That is a different configuration from the offline gate: the live
suite runs the 15 normally-skipped tests. It was not reproduced in this audit
(no live key), so treat 207/3 as unverified. The offline CI evidence is 196/15.

Not verified in this audit (no live key / no `gh` auth):

- `pnpm demo` real GitHub acceptance.
- `pnpm demo:feishu`.
- `pnpm bench:bakeoff` numbers.
- The live 207/3 count.

Do not mark those claims `[x]` until someone reproduces them.

## 9. How this document stays living

- When a gap is closed, change its status and add the PR link; do not delete the
  row, so the audit trail remains.
- A new row needs the same three things: status mark, file evidence, acceptance.
- Re-run the verification log in §8 on the commit under review; update the counts
  and the date. If `pnpm test` needs a live model, record the model id and the
  transcript path.
- The first-audit observations in §2/§3 remain as historical context; when
  quoting them, say which base they came from.
