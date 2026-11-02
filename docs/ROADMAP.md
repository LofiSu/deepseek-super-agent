# Plan audit and living roadmap

> Status: living document · First audit: 2026-11-02 against `8f8e104` ·
> Revised: 2026-11-02 against `e4ea8e9` · Repo: `LofiSu/deepseek-super-agent`
>
> Sources for current-state claims: `origin/main` at `e4ea8e9` (`PLAN.md`,
> `README.md`, `README.zh-CN.md`, `docs/install.md`, `docs/zh/install.md`,
> `docs/MODULES.md`, `docs/HARDENING_2026-11-01.md`), `src/`, `test/`,
> `package.json`, `.github/workflows/`, and the `gh` PR history.
>
> **History note.** On 2026-11-02 `main` was rewritten to drop the merged
> Mermaid-docs commit #42 (`f036790`), then again to drop non-owner
> `Co-Authored-By` trailers. Every commit from #41 onward was renumbered. SHAs
> in the revision history are provenance only; the work board keys off stable PR
> numbers, not SHAs.
>
> This file is **read-only evidence plus a plan**. It does not edit `PLAN.md`,
> `README.md`, `README.zh-CN.md`, or `docs/MODULES.md`.

## Revision history

| Date | Base | Change |
|------|------|--------|
| 2026-11-02 | `8f8e104` (#37) | Initial audit of the frozen `45c6619` tree plus its uncommitted refactor. |
| 2026-11-02 | `a38ea81` (#41) | Rebased after #40 and #41 merged; P0-1/P0-2 narrowed. |
| 2026-11-02 | `7f1c9a1` (#44) | Rebased again after #44, #46, and #51 merged; P0-1/P0-2/P0-3 resolved, P1-8 resolved, and all current-state claims re-audited. |
| 2026-11-02 | `ab90eae` | Re-audited after #53 (credential sentinel) and #54 (LTM retention) merged; P0-5 resolved, M6/P2-1 updated. |
| 2026-11-02 | `30bea75` | #55 sandbox docs and #56 PLAN §4/§10 merged; P1-10 resolved; P0-4 remaining §1.4 fix opened as #58. |
| 2026-11-02 | `f57fd2b` | #57 bounded lifecycle history and #58 PLAN §1.4 stack correction merged; P0-4 and P1-4 resolved. |
| 2026-11-02 | `e4ea8e9` | Post-rewrite re-audit after #39, #60, and #61: P1-2, P1-1/P1-7 (docs), and the slow-path/README claims resolved; C15/C12/C14 rows corrected. The board uses PR numbers; the rows above keep the SHAs observed at the time. |

PR history correction: the audit base `8f8e104` is **#37** (GitHub Pages).
**#38** (`566d308`, opt-in domain naming) merged just before it. The refactor is
**#40**, README/PLAN alignment is **#41**, the `MODULES.md` runner fix is
**#46**, the remaining opt-in reference cleanup is **#51**, and the fail-closed
sandbox is **#44**. #42 (`f036790`) was the Mermaid docs fix; it was
dropped by the 2026-11-02 history rewrite. There were no open PRs when the
initial audit started.

## 0. What changed since the first audit

The first audit described a detached `45c6619` tree with a 64-file uncommitted
refactor. **That refactor has merged as #40 (`4b919bd`).** On current `main`:

- `src/phase2/` does not exist.
- The services live in their owning modules:
  `src/ingress/shards.ts` (Router shards), `src/harness/mesh.ts` (Worker mesh),
  `src/memory/long-term.ts` (long-term memory), `src/core/lifecycle.ts`
  (lifecycle events), `src/channels/a2a.ts` + `a2a-transport.ts` (A2A).
- `docs/MODULES.md` and `docs/HARDENING_2026-11-01.md` are tracked.
- `PLAN.md`, both READMEs, both install pages, and the review-method docs no
  longer describe a `DS_AGENT_PHASE2` master switch (fixed by #41 and #51).
- The tracked-tree grep for
  `DS_AGENT_PHASE2|runtime.phase2|ProductShellBus|src/phase2` has only the two
  intentional negations in `PLAN.md:883,1056`.
- The filesystem sandbox is now **default-on and fail-closed** (#44): a missing
  `sandbox-exec`/`bwrap` throws instead of silently running unsandboxed bash.
  The wrapper confines writes and network, not reads. The docs that still
  described the old opt-in flag were corrected by #55; C15 is resolved.

The §2/§3 matrices keep audit-time observations where useful, but every
**current-state** claim below was re-checked against `e4ea8e9`.

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
| **M0 shared** | done | `src/shared/types.ts`, `ports.ts`, `events.ts`, `boundary.ts`; `test/ports.test.ts`; `npx tsc --noEmit` passes; `PLAN.md` §4.1 current-contract table | No contract gap after #56/#58: PLAN §4 is marked a historical sketch, §4.1 matches `Role`/`Strength`/`Assignment.state` and the real `Harness` methods, and §10 matches the tree. `node:sqlite` still requires Node ≥22. |
| **M1 harness** | done | `src/harness/loop.ts` (Router-before-Worker sequence at `145-160`, async jobs, batch window), `session.ts`, `model.ts`, `tools.ts`, `daemon.ts`, `machines.ts`, `team.ts`, `mesh.ts`; `test/job.test.ts`, `team-harness.test.ts`, `daemon-machines.test.ts`, `hardening.test.ts`, `live-modules.test.ts` | Worker-mesh capacity is a logical placement rule in one process: `pickNode` records the least-loaded node and logs `capacity-full`, but still runs the turn — there is no queue, rejection, or backpressure (P1-3, documented in `docs/MODULES.md`). `ds-agent serve` wraps the in-process `Daemon` timer over persisted state (no inbound channel loop) with SIGINT/SIGTERM drain and exit 0; an in-flight turn is still not reconstructed after restart (P1-6). |
| **M2 store** | done | `src/store/sqlite.ts` (`node:sqlite` at `:3`, `ds-agent.db` at `:16`), `schema.ts`, `spill.ts`, document/spill upsert; `test/spill.test.ts`, `long-term-memory.test.ts`, `live-modules.test.ts` (reopen) | No migration/version table; `node:sqlite` is experimental and needs Node ≥22. The §10 file-tree contradiction was resolved by #56: the plan now describes the real `sqlite.ts`/`schema.ts`/`spill.ts` tree. |
| **M3 engine** | done | `src/core/engine.ts`, `intake.ts`, `policy.ts`, `assessment.ts`, `tickets.ts`, `assignments.ts`, `replies.ts`, `subscribe.ts`, `collab.ts`, `lifecycle.ts`; `test/domain-alignment.test.ts`, `subscription.test.ts`, `speculate.test.ts`, `mid-task-collab.test.ts`, `hardening.test.ts`, `live-modules.test.ts` | P1-2 is resolved by #39: the deterministic `gateTriggers` handles commands and the configured auto-accept classes, and deferred triggers go to `assessWithMainAgent`, which originates `accept`/`ignore`/`stop`/`unavailable` (with `title`/`scope`/`strength`) before any Ticket exists. The gate remains rule/policy based by design; it is not a model verdict. |
| **M4 ingress** | partial | `src/ingress/filter.ts`, `shards.ts`, `thread.ts`, `batch.ts`; `test/filter.test.ts`, `router-shards.test.ts`, `runtime-integration.test.ts` | Fast Path is source + T16 admission (actor allowlist, group/chat allowlist read from `trigger.channel.address.group`, drop-self deny) + mention + keyword + noise; `test/filter.test.ts` covers each rule and the runtime env wiring. No shipped adapter populates `address.group` yet, so the group list is opt-in after the adapter supplies it. Admission is not authentication: a channel adapter must still verify its peer, and `meta` is never read. Slow Path is deterministic `ruleClassify` for both Mock and `HttpOpenAI` and is documented as such (#60); a model-backed policy is still open (P2-4). P2-2 is resolved: precedence is priority-desc then registration order, `default` is fallback-only, and the first matching shard owns the reply and terminal decision. Ownership is resolved from the trigger named by the call, and `Evals.decide` is idempotent per trigger, so only one terminal Router decision is recorded. Shards are routing metadata, not multi-process placement. |
| **M5 subscribe** | done | `src/core/subscribe.ts`, `intake.ts` fan-out; `test/subscription.test.ts`, `hardening.test.ts` (contextOnly, unsubscribe) | `handback` is not exposed as a CLI action. The tests cover unsubscribe but not the full requeue-and-drop lifecycle as an operator flow. |
| **M6 memory** | partial | `src/memory/recall.ts`, `acl.ts`, `long-term.ts`; `src/store/sqlite.ts` (`deleteSpill`); `test/spill.test.ts`, `long-term-memory.test.ts`, `live-modules.test.ts` | Recall is word-AND substring matching over a spill, not semantic or multi-hop. Retention landed in #54: `maxEntries`/`maxAgeDays` prune inside the same transaction as `put`/`remember`, `forget` deletes the spill and grants, and `DS_AGENT_MEMORY_MAX_ENTRIES`/`DS_AGENT_MEMORY_MAX_AGE_DAYS` configure it (defaults 1000/90). Dedupe and ranking are resolved (#68): `put()` reuses an existing same-ticket entry whose redacted text matches after whitespace/case normalization (tags unioned, no new row or spill), and `query()` orders by tagHits desc, textHits desc (each word capped at 5), createdAt desc, id desc; the exact formula is in `docs/MODULES.md` M6 and `test/long-term-memory.test.ts` proves it with an injected clock. Remaining: semantic search and the month-scale story. `README.md:115` still says "not month-scale"; that part is accurate. |
| **M7 speculate** | done | `src/speculate/silent.ts`, `gate.ts`; `test/speculate.test.ts`, `live-modules.test.ts`, `hardening.test.ts` | The gate is a clause-local keyword heuristic, documented as a stand-in (`docs/HARDENING_2026-11-01.md:25`). It is not a model verdict; a real value judgment remains open. |
| **M8 channels** | done | `src/channels/norms.ts`, `cli.ts`, `feishu.ts`, `github-source.ts`, `outbox-adapter.ts`, `a2a.ts`, `a2a-transport.ts`; `test/channels-feishu.test.ts`, `channels-github-source.test.ts`, `outbox.test.ts`, `lifecycle-a2a.test.ts`, `a2a-transport.test.ts`; real demos in `src/cli/demos/*` | Real-channel acceptance is operator-only: `test/demos-real-channels.test.ts` is skipped offline (3 tests), and `pnpm demo` needs `gh auth` plus a live model. There is no email adapter (the plan calls it optional). |
| **M9 env** | partial | `src/env/local-env.ts`, `sanitize.ts`, `vault.ts`, `seccomp.ts` (`sandboxEnabledFromEnv` returns true); `test/sanitize.test.ts`, `vault.test.ts`, `hardening.test.ts`, `local-env-timeout.test.ts`, `live-modules.test.ts`, `credential-sentinel.test.ts` | #44 made the sandbox default-on and fail-closed: a missing `sandbox-exec`/`bwrap` throws. Host vault/seccomp policy is still external. Credential non-leakage now has a single sentinel test (#53) covering SQLite tables, session JSONL, tool results, replies/outbox, and captured model request bodies, plus Worker port/tool rejection. #55 corrected the user-facing pages and historical reviews; this audit also fixed the remaining "optional OS sandbox" line in the `docs/MODULES.md` T51 section. C15/P1-10 are resolved. Host read isolation remains external. |
| **M10 watchdog** | partial | `src/watchdog/watchdog.ts`, `rules.ts`, `rules.json`, `health.ts`; `test/health.test.ts`, `daemon-machines.test.ts`, `live-modules.test.ts`, `hardening.test.ts` | Goal-drift detection is marker-based ("a running report that says it left the scope"), not a general NL comparison. `PLAN.md` T43–T44 ask for NL rules; `README.md:100` already calls this "thin". |
| **M11 CLI / demo** | partial | `src/cli/main.ts` (init/tasks/status/health/serve/chat/emit/metrics/memory/a2a/pause/intervene/resume/collab/team/teams), `src/cli/demos/run.ts`, `src/cli/bakeoff.ts`; `test/cli-memory-a2a.test.ts`, `cli-serve.test.ts`, `mid-task-collab.test.ts`, `live-demo.test.ts`, `live-e2e.test.ts` | `pnpm demo` (real GitHub issues/comments) is not in the automatic PR gate; it runs through the manual `acceptance.yml` dispatch and needs an operator with `gh auth`. `package.json` has no `bin`, no `build`, and `tsconfig` is `noEmit`, so the `PLAN.md` §10 `dist/cli.js` bin does not exist. `serve` runs the daemon timer over persisted state (no inbound channel loop) with clean SIGINT/SIGTERM shutdown; restart replay remains a boundary (P1-6). The `MODULES.md` runner claim is fixed by #46. |

## 3. Functional-domain matrix (PLAN §9)

| Domain | Status | Evidence | Gap |
|--------|--------|----------|-----|
| **评测与指标** (T45) | done | `src/metrics/metrics.ts`, `curve.ts`, `bakeoff.ts`, `batching-bench.ts`; `src/cli/bakeoff.ts`; `test/metrics.test.ts`, `metrics-curve.test.ts`, `batching-bench.test.ts`, `runtime-integration.test.ts` | Counters, `curveSamples`, `model.call`, `compareBakeoff`, and `pnpm bench:bakeoff` exist. A live bake-off is a manual measurement (needs a model key); it is not a CI gate. `docs/MODULES.md:197` claims 207 passed / 3 skipped on a live Magpie run; unverified in this audit (P1-9). |
| **扩展** — Router shards (T46) | done | `src/ingress/shards.ts`; `Disposition.shards` in `src/shared/types.ts:85-91`; `Runtime.create` registers `DS_AGENT_SHARDS` (`src/runtime.ts:151-166`); `Harness.launch` runs one Router session per shard (`src/harness/loop.ts:74-77,145-160`); `test/router-shards.test.ts`, `runtime-integration.test.ts` | P2-2 is resolved on `feat/shard-arbitration`: matches sort by `priority` desc then registration order, `default` is fallback-only, and every matching shard runs its Router session. The first shard is the single reply owner and the only session allowed to emit a terminal decision; later shards share the Ticket/Thread and are rejected by the tool guard. Ownership comes from the trigger named by the call (mismatched trigger/ticket pairs are rejected), and `Evals.decide` dedupes terminal decisions per trigger. Shards remain routing metadata, not multi-process placement. |
| **扩展** — Worker mesh (T47) | partial | `src/harness/mesh.ts`; `Assignment.node` in `src/shared/types.ts:102-120`; placement event in `src/harness/loop.ts:84-89,129-141`; `test/worker-mesh.test.ts`, `runtime-integration.test.ts` | Placement is logical and single-process. When capacity is full, `launch` logs `node=none capacity-full` and still runs the Worker; there is no queue, rejection, or backpressure. Cross-host transport is external, which is acceptable, but capacity enforcement is not. This is P1-3. |
| **长期记忆** (T48) | partial | `src/memory/long-term.ts`; write on terminal ticket in `src/runtime.ts:201-216`; recall injection in `src/runtime.ts:274-282`; `test/long-term-memory.test.ts`, `runtime-integration.test.ts` | One redacted entry per ticket, keyword AND recall, three results. #54 added retention (count/age, default 1000 entries / 90 days, 0 disables) with transactional spill+grant cleanup and configurable env. #68 added same-ticket dedupe (normalized redacted text, tag union, no extra row/spill, missing-spill zombies never reused) and deterministic tag+text+recency ranking (formula in `docs/MODULES.md` M6); P2-1 is resolved (#54, #68). Semantic/multi-hop search and the month-scale story remain open. Documented as partial in `README.md:115`. |
| **产品层** (T49) | external boundary + partial | `src/core/lifecycle.ts` (`LifecycleBus`, `subscribe`, `snapshot`); lifecycle publishing in `src/runtime.ts:190-216,432-469`; `ds-agent memory` / `ds-agent a2a` in `src/cli/main.ts:204-231`; `test/lifecycle-a2a.test.ts`, `cli-memory-a2a.test.ts`, `runtime-integration.test.ts` | The in-repo contract is done; the actual panel is another repository (PLAN §9 T49). P1-4 is resolved by #57: `LifecycleBus.history` is a bounded 1000-event ring (configurable, keep-newest) with tests. It is still in-memory, so a panel can replay only the current process; persistence is a documented boundary, not implemented. |
| **互操作** (T50) | external boundary + partial | `src/channels/a2a.ts`, `src/channels/a2a-transport.ts` (`A2ATransport`, `LocalA2ATransport`); `Runtime.sendA2A` and local recipient in `src/runtime.ts:319-328,390-395`; `test/lifecycle-a2a.test.ts`, `a2a-transport.test.ts`, `runtime-integration.test.ts` | Validation, 64 KiB UTF-8 byte cap, identity normalization, persistence, `delivered\|unroutable\|failed`, and a filtered non-human `a2a` Trigger exist. P1-5 is resolved by the exported contract, local double, and boundary tests. The cross-process wire transport and peer authentication remain external; an adapter must add both and never expose the local endpoint unauthenticated. |
| **安全与隐私** (T51) | external boundary + partial | `src/env/sanitize.ts` (allowlist, secret redaction), `vault.ts`, `seccomp.ts`; `test/sanitize.test.ts`, `vault.test.ts`, `hardening.test.ts`, `local-env-timeout.test.ts`, `credential-sentinel.test.ts` | In-repo: env allowlist, spill redaction, `[redacted]` output, FileVault names only, default-on fail-closed OS sandbox (#44), spill ACL, untrusted `meta` rejection, and a single sentinel test across SQLite/journal/tool results/model requests plus Worker port/tool rejection (#53). External: host-level vault/seccomp, true host read isolation (the wrapper confines writes/network only), and provider `Authorization` header/vault values not covered by the offline sentinel. Sandbox docs corrected by #55. |

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
   tree, or the contract is rewritten to say it is a design sketch. **Resolved
   by #56/#58 (P0-4).**
6. The build/package story is decided: either a working `build` + `bin` +
   `dist`, or an explicit "source-only via `pnpm`/`tsx`" statement in README and
   `package.json`. **Resolved as source-only (P1-7); the statement is in both
   READMEs and both install pages.**

### 4.2 Tests

1. Offline PR gate: `pnpm typecheck` + `DS_AGENT_ALLOW_MOCK_FIXTURE=1 pnpm test`
   green, with no live key, on every PR. New domain tests must run, not skip.
2. Live reference run: `pnpm test` green on a documented model/gateway, with the
   date, model id, pass/skip counts, and transcript path recorded.
   `docs/MODULES.md:197` claims 207 passed / 3 skipped; reproduce it (P1-9).
3. Real-channel acceptance: `pnpm demo` (real GitHub issues + comments) and
   `pnpm demo:feishu` run on a release candidate, with artifacts under
   `/tmp/ds-agent-live-e2e-logs/`. A green offline suite is not a substitute.
4. Security probes are automated: a sentinel credential value must not appear in
   any session event, prompt, tool result, spill, or journal; a Worker call to
   `reply`/`decide`/`receive` must throw; a speculative ticket must be absent
   from `visibleTickets` until the gate delivers. **Satisfied by #53**, except
   the provider `Authorization` header, external transports, and vault-injected
   values, which stay documented limits.
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
- A2A network transport and peer authentication (the in-repo `A2ATransport`
  contract and local double are in `src/channels/a2a-transport.ts`).
- Multi-host Worker mesh transport.
- Managed credential storage / cloud executor.

## 5. Documentation contradictions

Status is against current `main` (`e4ea8e9`). Resolved rows are kept so readers
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
| C8 | Slow Path "can call a model". | `README.md:64`; `README.zh-CN.md:64` | Both `MockModel.classify` and `HttpOpenAI.classify` call `ruleClassify` (`src/harness/model.ts:89,167`; `src/ingress/filter.ts`); no admission decision is sent to the model. #60 rewrote the README to say the shipped classifier is deterministic and a model-backed policy classifier is not wired. | resolved (#60) |
| C9 | Tests default to `MockModel`. | `PLAN.md:50` | The default suite refuses `MockModel`: `test/fixtures.ts:11-24` throws unless `DS_AGENT_ALLOW_MOCK_FIXTURE=1`; `README.md:235` documents the live requirement. #58 corrected PLAN to "default live, Mock only for fixture-gated offline CI". | resolved (#58) |
| C10 | Runtime is Node ≥20. | `PLAN.md:48` | `package.json:8-10` requires Node ≥22; `src/store/sqlite.ts:3` uses `node:sqlite`. #58 corrected PLAN §1.4 to Node ≥ 22. | resolved (#58) |
| C11 | Real Feishu/GitHub sources are out of scope before M11. | `PLAN.md:39-40` | M8 ships `src/channels/feishu.ts` (webhook parser + polling source) and `src/channels/github-source.ts`; `README.md:275-298` makes real channels the acceptance path. | remaining (stale boundary table) |
| C12 | PLAN §4 freezes `SessionRole`, `Assignment.status`, and a `Harness.injectJobResult` API that the code does not have. | `PLAN.md:280,342,538` | `src/shared/types.ts:1` defines `Role`; `:5` adds `maybe` to `Strength`; `:104` uses `Assignment.state`; no `injectJobResult`. #56 marks §4 as a historical sketch and adds the §4.1 current-contract table. | resolved (#56, #58) |
| C13 | `docs/MODULES.md` says `src/cli/demo.ts` drives the real-channel acceptance scenarios. | `docs/MODULES.md:140-141` | `pnpm demo` points at `src/cli/demos/run.ts`; `src/cli/demo.ts` is the offline fixture baseline. Fixed by #46. | resolved (#46) |
| C14 | PLAN says the DB is `better-sqlite3` or `node:sqlite` in `ds-agent.sqlite`. | `PLAN.md:49` | `src/store/sqlite.ts:3,16` uses `node:sqlite` and `ds-agent.db`. #58 corrected PLAN §1.4. | resolved (#58) |
| C15 | The OS sandbox is opt-in via `DS_AGENT_SANDBOX=1`, and bash falls back to unsandboxed execution when the wrapper is missing. | `README.md:119`; `README.zh-CN.md:115`; `docs/MODULES.md:126`; `docs/safety.md:29,31`; `docs/zh/safety.md:30,32`; `docs/HARDENING_2026-11-01.md:39`; `docs/LIVE_CODE_REVIEW_2026-11-01.md:130,185` | #44 made sandboxing default-on and fail-closed: `sandboxEnabledFromEnv` returns true and `wrapBashCommand` throws if `sandbox-exec`/`bwrap` is missing. Explicit `enabled: false` is only a test/embedding opt-out. #55 corrected every doc listed here. | resolved (#55) |

Doc hygiene, not false claims:

- Audit-time §10 listed files that do not exist (`src/app/runtime.ts`, `db.ts`,
  `repos.ts`, `migrate.ts`, and others). #56 corrected §10 to the real tree, so
  this is no longer a contradiction.
- `docs/REVIEW.md`, `docs/LIVE_CODE_REVIEW_2026-11-01.md`, and
  `docs/ARCHITECTURE_REVIEW.zh.md` are snapshots. `ARCHITECTURE_REVIEW.zh.md`
  now has a status note via #51; the other two should get the same banner.

## 6. Ranked gaps

### Resolved since the first audit

**P0-1. Land the refactor — resolved by #40.**
`src/phase2/` is gone, the new services and tests are tracked, and
`docs/MODULES.md` + `docs/HARDENING_2026-11-01.md` are on `main`.

**P0-2. Remove the stale opt-in documentation — resolved by #41 and #51.**
`PLAN.md` and both READMEs were aligned in #41; `docs/install.md:62`,
`docs/zh/install.md:63`, `docs/ARCHITECTURE_REVIEW.zh.md:7,17`, and
`docs/CODE_REVIEW_METHOD.md:52` were fixed in #51. The only remaining matches
are the two explicit negations in `PLAN.md:883,1056`.

**P0-3. Put `docs/MODULES.md` on `main` and fix the runner claim — resolved by
#46.**
The file is tracked and points at `src/cli/demos/run.ts`. Test-count
reproducibility moved to P1-9.

**P1-8. Fail closed when no filesystem sandbox is available — resolved by
#44.**
`sandboxEnabledFromEnv` is true by default and `wrapBashCommand` throws when the
platform wrapper is missing; CI installs `bubblewrap`. The documentation half
(P1-10) was resolved by #55.

### P0 — top open gaps

**P0-4. Re-freeze the interface contract.**
Status: resolved by #56 and #58.
At audit time, `PLAN.md:280` froze `SessionRole`; `PLAN.md:342` froze
`Assignment.status`; `PLAN.md:538` froze `Harness.injectJobResult`;
`src/shared/types.ts:1` defines `Role`, `:5` adds `maybe`, `:104` uses
`Assignment.state`, and no `injectJobResult` exists. `PLAN.md:49` also named
`better-sqlite3`/`ds-agent.sqlite`, while the code uses `node:sqlite` and
`ds-agent.db`. `PLAN.md` §10 listed files that do not exist.
Acceptance: PLAN §4 either matches `src/shared/types.ts`/`ports.ts` or is
renamed "illustrative"; §10 matches the real tree; `npx tsc --noEmit` stays
green; a short contract test or doc check catches future drift.
PR #56 marks §4 as a historical sketch with a current-contract table and
corrects §10; PR #58 corrects §1.4 (`node:sqlite`, `ds-agent.db`, Node ≥ 22,
live-model default) and the §1 MockModel/demo row.

**P0-5. Prove credential non-leakage on every path.**
Status: resolved by #53, with documented coverage limits.
Evidence: `test/credential-sentinel.test.ts` injects a unique sentinel via
`DS_AGENT_API_KEY`, drives a ticket through `Runtime` with a capturing model,
and asserts absence from every SQLite table found via `sqlite_master` (messages,
documents, spills, events, replies, outbox, sessions, jobs, artifacts), the
session JSONL, spill bodies, persisted tool results, the runtime log, and every
captured model request body. It also asserts Worker tool/port rejection.
Limits: the provider `Authorization` header necessarily carries the credential;
external Feishu/GitHub transports and vault-injected values are not covered by
this offline test.
Acceptance met; keep the limits visible.

### P1 — needed for a defensible "complete"

**P1-1. Automate or formally checklist the real-channel acceptance.**
Status: resolved by #61. `.github/workflows/acceptance.yml` is a
manual `workflow_dispatch` job that takes a ref, model base/id, and target repo;
requires `DS_AGENT_API_KEY`/`DEEPSEEK_API_KEY` and accepts `DS_AGENT_GH_TOKEN`
(falling back to the workflow's `GITHUB_TOKEN`); installs
`bubblewrap`; runs the live `pnpm test` suite and `pnpm demo`; and uploads the
logs as artifacts. `test/demos-real-channels.test.ts` still skips its 3 tests
offline, and the job remains operator-dispatched rather than a PR gate, because
it needs live credentials and a writable repo.
Acceptance: the workflow exists and fails closed on missing credentials; the
remaining evidence step is a dated live run (P1-9).

**P1-2. Finish the Router assessment or downgrade the claim.**
Status: resolved by #39. The pipeline is now Gate → Main Agent
assessment → Mandate/Ticket → Executor. `gateTriggers` handles commands and the
configured auto-accept classes; when it defers, `assessWithMainAgent`
(`src/core/assessment.ts`) emits `accept`/`ignore`/`stop`/`unavailable`; the
prompt asks for `title`/`scope`/`strength`, and the parser accepts them as
optional (title falls back to the message label, scope to the title).
Subscription carries context without
granting authority, failed/blocked/waiting reports end only the Assignment, and
replies route back to the originating Thread. `test/domain-alignment.test.ts`
locks the path, including the spill-grant origin check.
Acceptance met. The deterministic Gate is still rule/policy based by design; it
is not a model verdict.

**P1-3. Enforce mesh capacity.**
Status: accepted as a documented design boundary (not enforced). `pickNode`
logs `capacity-full` and the turn still runs. `docs/MODULES.md` now says
explicitly that capacity is a placement preference, with no queue, rejection, or
backpressure. Enforcing it would be a new scheduler contract, not a bug fix.
Remaining option: add a queue/reject mode with a domain outcome and test if that
contract is wanted.

**P1-4. Make the lifecycle read model replayable.**
Status: resolved by #57, with an explicit current-process boundary.
`LifecycleBus.history` is now a bounded ring (default 1000, keep-newest;
configurable, invalid capacities throw) and `test/lifecycle-a2a.test.ts` covers
the cap. Events are still not persisted, so the T49 row and `docs/MODULES.md`
state that a panel can replay only the current process. SQLite persistence
remains a documented non-goal; nothing in the product claims restart replay.

**P1-5. Define the A2A adapter contract and authentication note.**
Status: resolved (contract + local double); the network adapter remains external.
`src/channels/a2a.ts` stays in-process. `src/channels/a2a-transport.ts` exports
`A2ATransport` (`send(envelope)` returning `A2ADelivery` or a promise, optional
`receive(listener)`) and `LocalA2ATransport`, which wraps `A2ARouter.send` and
inherits validation, the 64 KiB UTF-8 byte cap, persistence, and delivery
statuses. `send` copies only `{ from, to, body }`, assigns fresh `id`/`at`, and
drops unknown fields, so a peer cannot overwrite or backdate a persisted
envelope. `test/a2a-transport.test.ts` covers delivery, unroutable, handler
failure, empty/invalid envelopes (including the byte cap and non-serializable
bodies), persistence, identity normalization, and the security boundary: an
envelope that forges `human` still becomes a non-human `a2a` Trigger and still
passes the ingress filter (a forged flag changes no admission outcome).

Exact remaining external boundary: there is no network transport and no peer
authentication in this repo. An adapter must move the envelope over its wire,
authenticate the peer (mTLS, signed envelopes, bearer tokens, etc.), and hand
inbound bytes back through `A2ARouter.send` (which normalizes identity/timestamps
and drops unknown fields). It must never construct a Trigger or copy identity
from the envelope body. Attributing a human identity through this contract is
not supported, including by bypassing ingress via `runtime.ingest`. Do not expose
the local endpoint unauthenticated.

**P1-6. Standalone daemon / `serve` and in-flight resume.**
Status: partially resolved (serve landed). `ds-agent serve` creates one Runtime,
starts the in-process `Daemon` timer over persisted SQLite state, logs a ready
line, and stays alive until SIGINT or SIGTERM. It starts no inbound channel loop,
so triggers written by a separate `emit`/`chat` process are not picked up. The
model is resolved once at `Runtime.create`, so credentials added later require a
restart. With no provider key the idle daemon falls back to MockModel and leaves
Gate-deferred assessments queued for a live-model start. `chat` and `serve` may
run on MockModel; `demo`/`retry`/`resume` require a live model.
The first signal drains `Runtime.finish()` (Main Agent assessments, Harness jobs,
the daemon timer, SQLite) and exits 0; a second signal force-exits 1 if the drain
hangs. `finish()` stops the daemon and closes SQLite even when a drain step
rejects. `test/cli-serve.test.ts` covers key-free startup, a concurrent health
read, deferred work left intact for a live-model start, exit 0 on SIGTERM and
SIGINT, and a writable SQLite file afterward.
Remaining boundary: an in-flight turn is still not reconstructed after restart.
A killed process's unfinished jobs/sessions are not replayed; `docs/MODULES.md`
states this and no product surface claims replay. Restart replay remains a
product decision.

**P1-7. Decide the packaging story.**
Status: resolved as a source-only decision. `package.json` deliberately has no
`bin`, no `build`; `tsconfig` is `noEmit`. The repo is consumed from source with
`pnpm`/`tsx` (`pnpm ds-agent`), not installed from npm. `docs/install.md`,
`docs/zh/install.md`, and the README now say so, and PLAN §10 no longer promises
a `dist/cli.js` binary. Publishing an npm package would be a new product
decision, not a missing implementation of M0–M11.

**P1-9. Reproduce the live reference run.**
Status: partially reproduced, still open. `docs/MODULES.md:197` claims 207
passed / 3 skipped on a live Magpie run (431.12 s). On the pre-rewrite #44 tree
(`7f1c9a1`), the previously red live tests `job`, `ports`, and `metrics` pass
together (13/13, 90.48 s). A full `pnpm test` on that tree reached 206 passed /
3 skipped with 2 failures that
were both upstream provider 429s (`live-modules` model call; `metrics` saw
`model.error: 3` instead of 0), not product assertions. Re-run with a healthy
provider quota and record the dated counts; update `docs/MODULES.md` if the
reference number changes.
Suggested workstream: release agent, `ci/live-reference-run`.

**P1-10. Correct the sandbox documentation after #44.**
Status: resolved by #55.
Evidence: `README.md:119`, `README.zh-CN.md:115`, `docs/MODULES.md:139-141`,
`docs/safety.md:29,31`, `docs/zh/safety.md:30,32`,
`docs/HARDENING_2026-11-01.md:39`, `docs/LIVE_CODE_REVIEW_2026-11-01.md:130,185`
(the last three are historical snapshots; add a status note rather than rewrite
history).
Acceptance: user-facing docs say sandboxing is default-on and fails closed when
`sandbox-exec`/`bwrap` is absent; explicit opt-out is described as test/embedding
only; the historical reviews get a status note; read isolation is not overclaimed.
PR #55 covered all of these, added the `bwrap`/`sandbox-exec` requirement to both
install pages, and stated that writes/network are confined but reads are not.

### P2 — quality and scale

**P2-1. Long-term memory scale:** retention/size cap, dedupe policy, and a
semantic or tag+recency ranking. Acceptance: a test with >N entries proves the
cap; MODULES documents the recall formula. Resolved: #54 added the cap and
spill/grant cleanup; the dedupe policy and tag+text+recency ranking are
documented in `docs/MODULES.md` M6 and pinned by `test/long-term-memory.test.ts`
(tag hits, text hits, recency/id ties, dedupe row/spill counts, tag AND filter);
the board/P2-1 close-out is #68. Semantic search is not claimed.
**P2-2. Shard arbitration:** define precedence and reply ownership when multiple
shards match; add a test. Acceptance: at most one terminal decision per trigger
unless explicitly documented. Resolved on `feat/shard-arbitration`: non-default
matches sort by `priority` desc then registration order; `default` is returned
only when the list is empty; the first shard is the reply and terminal-decision
owner. Every matching shard still runs its Router session, but a later shard is
rejected by the tool guard. The owner is resolved from the trigger named by the
call (not merely from the ticket's origin trigger), and `Evals.decide` is
idempotent per trigger, so repeated or competing stop calls cannot add a second
Decision. Shards select Router sessions only; they are not process placement.
**P2-3. Fast-path allowlists:** actor/group/drop-self rules from T16.
Status: resolved by #67. `AdmissionRules` runs on the fast path before
mention/keyword, so an @-mention cannot bypass a deny rule. The group id comes
from `trigger.channel.address.group`, never `meta`; a missing group is denied
while the list is active. These are admission filters, not authentication.
Configure with `RuntimeOptions.admission` or the comma-separated
`DS_AGENT_ACTOR_ALLOWLIST` / `DS_AGENT_GROUP_ALLOWLIST` / `DS_AGENT_DROP_SELF`
variables; explicit options win, and unset lists leave admission unchanged.
Acceptance: `test/filter.test.ts` covers each rule plus runtime env wiring.
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
| P0-1 | Land refactor + MODULES/HARDENING |  | `refactor/m0-m11-modules` | #40 | resolved | Merged; `src/phase2` gone; domain tests run in CI |
| P0-2 | Remove stale opt-in docs |  | `docs/module-boundaries` | #41, #51 | resolved | Only the two explicit negations in `PLAN.md` remain |
| P0-3 | Fix `MODULES.md` demo runner |  | `docs/m11-demo-runner-fix` | #46 | resolved | Points at `src/cli/demos/run.ts` |
| P0-4 | Re-freeze PLAN §4/§10 contract |  | `docs/plan-contract`, `docs/plan-stack` | #56, #58 | resolved | Plan matches `src/shared` and the real tree, or says illustrative; §1.4 matches Node 22/node:sqlite; typecheck green |
| P0-5 | Credential sentinel test across store/journal/prompt/tool |  | `test/credential-sentinel` | #53 | resolved | Sentinel absent from all SQLite tables, session JSONL, tool results, and captured model requests; Worker port/tool calls throw |
| P1-1 | Real-channel acceptance job/checklist |  | `ci/real-channel-acceptance` | #61 | resolved (manual dispatch) | `workflow_dispatch` runs live `pnpm test` + `pnpm demo`, fails on missing credentials, uploads logs |
| P1-2 | Router assessment / domain alignment |  | `fix/domain-alignment-article` | #39 | resolved | Main Agent originates `accept`/`ignore`/`stop`/`unavailable`; domain-alignment test green |
| P1-3 | Mesh capacity enforcement |  |  |  | accepted boundary (documented) | Placement is logical; no queue/backpressure. `docs/MODULES.md` says so |
| P1-4 | Lifecycle replayability |  | `feat/lifecycle-history-cap` | #57 | resolved (current-process replay only) | Bounded history (default 1000) + test; no persistence claim |
| P1-5 | A2A transport interface + auth note |  | `a2a-transport` | #65 | resolved (contract + local double) | In-process contract + local double now exist: `A2ATransport` + `LocalA2ATransport` in `src/channels/a2a-transport.ts`, tests in `test/a2a-transport.test.ts`. Remaining external boundary: network transport + peer authentication must be supplied by an adapter |
| P1-6 | `ds-agent serve` + in-flight resume |  | `daemon-serve` | #66 | partially resolved (serve; no restart replay) | `serve` runs the daemon timer over persisted state (no inbound channel loop), drains on SIGINT/SIGTERM, exits 0; second signal forces 1. In-flight turn is still not reconstructed after restart |
| P1-7 | Packaging decision |  |  |  | resolved (source-only) | No `bin`/`build`; install docs say source-only via `pnpm` |
| P1-8 | Fail-closed filesystem sandbox |  | `fix/env-fail-closed-sandbox` | #44 | resolved | Missing wrapper throws; CI installs `bubblewrap` |
| P1-9 | Reproduce live reference run |  |  |  | partially reproduced | 3/3 previously red live files pass; full run hit provider 429, not assertion failures |
| P1-10 | Correct sandbox docs to default-on/fail-closed |  | `docs/fail-closed-sandbox` | #55 | resolved | User docs no longer describe `DS_AGENT_SANDBOX=1` opt-in; reads not overclaimed |
| P2-1 | LTM retention/ranking |  | `feat/ltm-retention`, `feat/ltm-ranking-dedupe` | #54, #68 | resolved | Retention 1000/90 + spill cleanup (#54); dedupe (same-ticket normalized text, tag union, no extra row/spill) and tagHits/textHits/createdAt/id ranking tested with an injected clock; formula in `docs/MODULES.md` M6 |
| P2-2 | Shard arbitration | LofiSu | `feat/shard-arbitration` | #69 | resolved | Precedence documented + tests: priority-desc/registration order, default fallback-only, first shard owns reply + terminal decision; owner resolved from the supplied trigger; idempotent decisions; one ticket/decision per trigger |
| P2-3 | Fast-path allowlists |  | `feat/ingress-allowlists` | #67 | resolved | `AdmissionRules` actor/group/drop-self before mention/keyword; group from channel address; tests cover each rule + env |
| P2-4 | Slow-path policy vs claim |  |  |  | todo | Code or README changed, tested |
| P2-5 | Coverage + lint in CI |  |  |  | todo | Scripts exist; policy documented |
| P2-6 | Confirm `repro-h9*.ts` removed |  |  |  | todo | Root clean |
| P2-7 | Status banners on review snapshots |  |  |  | todo | Historical banner on each |
| P2-8 | Email channel decision |  |  |  | todo | PLAN and code agree |
| R-1 | This audit | planning-review agent | `docs/roadmap` | #43 | resolved | File merged; board updated when gaps move |

## 8. Verification log

### Audit-time (historical)

Run on the frozen tree at `45c6619` plus its uncommitted refactor, Node
`v22.23.4`, pnpm `9.15.9`:

```text
npx tsc --noEmit                                      pass
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run  195 passed, 15 skipped, 34 files, 2.32 s
```

### Current main (`e4ea8e9`, re-checked 2026-11-02)

```text
npx tsc --noEmit                                      pass
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run  213 passed, 15 skipped, 35 files, 2.13 s
```

### P2-2 branch (`feat/shard-arbitration`)

```text
npx tsc --noEmit                                      pass
npx vitest run test/router-shards.test.ts             7 passed, 1 file
npx vitest run test/runtime-integration.test.ts       13 passed, 1 file
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run  273 passed, 15 skipped, 41 files
```

The 15 skipped tests are the live/real-channel suites:
`demos-real-channels.test.ts` (3), `live-demo.test.ts` (3), `live-e2e.test.ts`
(7), `team-live.test.ts` (2). `live-modules.test.ts` runs under
`DS_AGENT_ALLOW_MOCK_FIXTURE=1` and passed. The earlier CI run `41381516075` on
the pre-rewrite #44 tree reported 196 passed / 15 skipped / 35 files; #39, #53,
#54, #57, #60, and the docs PRs account for the additional 17 offline tests.

`docs/MODULES.md:197` claims a **live** Magpie run of 207 passed / 3 skipped
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
