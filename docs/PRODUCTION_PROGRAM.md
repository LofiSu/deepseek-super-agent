# Production completion program

> Owner message, 2026-11-04, quoted verbatim:
>
> > PLAN 全部任务 [x]、产品可用、生产就绪语义长期记忆、UI、跨主机 mesh、网络 A2A + peer auth、模型慢路径、live bake-off 实测、host read isolation 和 store migration；全部完成
>
> This document turns that directive into ordered workstreams. `PLAN.md`
> remains the architecture contract; `docs/ROADMAP.md` remains the evidence
> board; this file is the execution program for the remaining gaps.
>
> Baseline: `main` = `af834b7` (2026-11-04). Post-merge CI run
> `41801094141` on `af834b7` is green. Nothing in this document is a
> completion claim; each item needs code, tests, independent review, green CI
> on the exact head, and a merge.

## Definition of done

The program is complete only when all of the following hold:

1. Every `PLAN.md` task T01–T51 is `[x]`, or a task is explicitly re-scoped by
   the owner with a recorded decision. No `[~]` remains.
2. The product is usable by someone who is not the author: installable CLI,
   documented configuration, a working local UI, health/backup/restore paths,
   and an upgrade path for an existing SQLite database.
3. Production-readiness gates pass:
   - every network surface authenticates its peer and fails closed;
   - schema changes are versioned, transactional, and non-destructive;
   - worker execution has documented write/network/read confinement;
   - credentials remain outside model context, tool results, and logs;
   - restart, crash, and queue-drain behavior is tested;
   - no open Critical/High finding is unclassified.
4. Offline CI is green on `main`; the live bake-off is recorded with a date,
   provider, counts, and latency; real-channel acceptance remains
   operator-dispatched and is not claimed unless actually run.
5. Every PR has an independent review verdict and zero unresolved review
   conversations. High-risk PRs have explicit owner approval before merge.

## Workstreams

### W1 — Foundation (in progress)

| Task | Status | Owner files | Acceptance |
|---|---|---|---|
| STORE-MIGRATIONS | agent running (`agent/store-migrations`) | `src/store/schema.ts`, `src/store/sqlite.ts`, `test/store-migration.test.ts` | `schema_migrations`, versioned transactional upgrade, legacy baseline, fail-closed future version, no data loss |
| HOST-READ-ISOLATION | agent running (`agent/host-read-isolation`) | `src/env/seccomp.ts`, `src/env/local-env.ts`, `test/sandbox-read-isolation.test.ts` | opt-in strict read allowlist on Darwin/Linux, no blanket `/` or home read, invalid env fails closed, existing behavior unchanged when off |
| PACKAGING | done (PR pending merge) | `package.json`, `tsconfig.build.json`, `src/cli/main.ts`, `src/cli/version.ts`, `scripts/package-smoke.ts`, docs | `pnpm build` emits `dist/`, `bin.ds-agent`, install/run without `tsx`, `ds-agent --version` prints the package version; evidence in `test/packaging.test.ts` and `docs/install.md` |

### W2 — Recall and policy

| Task | Status | Owner files | Acceptance |
|---|---|---|---|
| SEMANTIC-LTM-IMPL | peer agent running (`agent/memory-recall-followup`) | `src/memory/long-term.ts`, memory tests, M6 docs | ADR-010 acceptance: normalization + synonyms + tag-aware one-hop, held-out queries, 1000-entry bound, ACL preserved |
| MODEL-SLOW-PATH (T17) | design required | `src/ingress/filter.ts`, `src/harness/model.ts`, admission path, tests | model-backed policy with structured output, timeout, deterministic fallback, no silent network in offline CI |
| LIVE-BAKEOFF (T45) | measured; evidence in PR #115 | `docs/BAKEOFF.md` (new), no product code | dated local-Magpie run: dual vs single model calls, tickets, wall time; limitations stated |

### W3 — Product shell (T49)

| Task | Status | Owner files | Acceptance |
|---|---|---|---|
| LIFECYCLE-PERSISTENCE | not started | `src/core/lifecycle.ts`, `src/store/schema.ts`, `src/runtime.ts`, tests | lifecycle events survive restart; bounded replay; migration added |
| LOCAL-UI | not started | `src/ui/*` (new), `src/cli/main.ts`, tests, docs | `ds-agent ui` binds 127.0.0.1, read-only ticket/thread/outbox/health views, optional local token, no remote code |
| ONE-UI-MANY-TOPICS | not started | UI + lifecycle read model | tickets, threads, assignments, and outbox visible without a Session; no fake data |

### W4 — Interop and distributed execution (T47/T50)

| Task | Status | Owner files | Acceptance |
|---|---|---|---|
| A2A-HTTP + PEER-AUTH | design + owner gate | `src/channels/a2a-http.ts` (new), `src/channels/a2a-auth.ts` (new), tests | authenticated HTTP transport, signed envelope, timestamp + nonce replay window, size cap, identity never trusted from body |
| CROSS-HOST-MESH | design + owner gate, depends on A2A auth | `src/harness/mesh.ts`, `src/harness/remote-node.ts` (new), tests | node registration/heartbeat, capacity, remote assignment dispatch, authenticated transport, fail-closed on unknown peer |
| ROUTER-SHARD-MULTI-FILTER (T09/T46) | not started; local multi-filter first, remote registration depends on A2A auth | `src/ingress/shards.ts`, `src/runtime.ts`, tests | multiple filters per shard, deterministic priority/registration arbitration, first matching shard owns reply and terminal decision, remote shard registration over the authenticated transport |
| A2A/UI THREAT MODEL | design | `docs/SECURITY.md` or ADR | adversary model, key distribution, rotation, TLS expectations, local-endpoint warning |

### W5 — Operations and release

| Task | Status | Acceptance |
|---|---|---|
| BACKUP/RESTORE | not started | documented + tested `ds-agent backup`, `ds-agent restore`; WAL-safe |
| UPGRADE RUNBOOK | not started | migration + rollback procedure, version compatibility table |
| CONTAINER PROFILE | not started | default-deny read profile for workers; docs distinguish this repo from host policy |
| HEALTH/OBSERVABILITY | partial | health covers schema version, read isolation, mesh transport, auth mode |
| RELEASE | not started | version bump, CHANGELOG, tag/release workflow, install smoke |

## Sequencing

1. **Cycle A (current):** W1 migrations + read isolation; W2 semantic LTM (peer); live bake-off measurement; this program doc.
2. **Cycle B:** model slow path ADR + implementation; packaging; lifecycle persistence.
3. **Cycle C:** local UI; A2A HTTP + peer-auth ADR (owner gate).
4. **Cycle D:** cross-host mesh on the shared auth primitive; router shard multi-filter and remote registration; backup/restore; container profile.
5. **Cycle E:** final audit, docs reconciliation, live acceptance, release.

Do not start W4 before the W4 ADR is reviewed: it changes authentication and
network exposure. Do not flip read isolation or model admission from opt-in to
default until the opt-in path has a green suite and a documented smoke test.

## Risk gates

| Change | Gate |
|---|---|
| A2A peer authentication, mesh identity, permission model | ADR + explicit owner approval before merge; threat model; replay tests |
| New network listener | bind loopback by default; explicit opt-in for remote; token/TLS required; fail closed |
| Schema migration | additive only unless owner approves destructive; transaction + backup + rollback test |
| Read isolation default | opt-in first; default flip is a separately reviewed PR with container docs |
| Breaking API (e.g. async admission) | opt-in flag or major version; migration notes; owner approval |
| Live model/channel run | credentials present, operator authorization, recorded evidence; never fabricated |

## Evidence ledger

Update this table after each merged PR; do not mark a row done from a branch
alone.

| Item | PR | Merge | CI | Evidence |
|---|---|---|---|---|
| STORE-MIGRATIONS | pending | — | — | — |
| HOST-READ-ISOLATION | pending | — | — | — |
| SEMANTIC-LTM-IMPL | peer-owned | — | — | — |
| LIVE-BAKEOFF | #115 | — | — | local Magpie run 2026-11-04T08:44Z: dual 11 calls / 38,805 ms vs single 10 calls / 38,684 ms; `wallRatio=1.0031`; summary and raw JSON appendix in `docs/BAKEOFF.md` |
| MODEL-SLOW-PATH | not started | — | — | — |
| LIFECYCLE-PERSISTENCE | not started | — | — | — |
| LOCAL-UI | not started | — | — | — |
| A2A-HTTP + PEER-AUTH | not started | — | — | owner gate |
| CROSS-HOST-MESH | not started | — | — | owner gate |
| ROUTER-SHARD-MULTI-FILTER (T09/T46) | not started | — | — | — |
| PACKAGING/RELEASE | pending | — | local: typecheck + lint + `test/packaging.test.ts` | PACKAGING complete: `dist/` + `bin.ds-agent` build, `ds-agent --version`, install docs corrected, `scripts/package-smoke.ts` covers the built CLI. RELEASE: workflow already on `main` (PR #132); publish remains a human step per `docs/RELEASE.md` |
