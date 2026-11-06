# Production completion program

> Owner message, 2026-11-04, quoted verbatim:
>
> > PLAN 全部任务 [x]、产品可用、生产就绪语义长期记忆、UI、跨主机 mesh、网络 A2A + peer auth、模型慢路径、live bake-off 实测、host read isolation 和 store migration；全部完成
>
> This document turns that directive into ordered workstreams. `PLAN.md`
> remains the architecture contract; `docs/ROADMAP.md` remains the evidence
> board; this file is the execution program for the remaining gaps.
>
> Baseline: `main` = `6d4707d` (2026-11-06). This revision reconciles the
> program against the code actually on that tip; the previous baseline was
> `af834b7` (2026-11-04). Packaging `--version` surface from #160 is merged and is
> counted as landed here.
>
> Status legend: **done** = merged on `main` with tests that pass offline;
> **[~] partial** = the code landed but the stated acceptance is not fully
> met; **owner-gated** = the code exists but activation or exposure needs an
> owner/operator decision; **human step** = deliberately outside CI.
> Nothing in this document is a completion claim without the evidence row.

## Definition of done

The program is complete only when all of the following hold:

1. Every `PLAN.md` task T01–T51 is `[x]`, or a task is explicitly re-scoped by
   the owner with a recorded decision. No `[~]` remains. The only open `[~]`
   item below is T48 month-scale measurement; it needs an owner re-scope
   decision or dated evidence, not a status edit.
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

### W1 — Foundation (landed)

| Task | Status | Owner files | Acceptance |
|---|---|---|---|
| STORE-MIGRATIONS | done (#116, `39ff321`) | `src/store/schema.ts`, `src/store/sqlite.ts`, `test/store-migration.test.ts` | `schema_migrations` ledger, versioned transactional upgrade, legacy baseline, fail-closed future version, no data loss; `LATEST_SCHEMA_VERSION = 4` |
| HOST-READ-ISOLATION | done (#117, `0201b4f`) | `src/env/seccomp.ts`, `src/env/local-env.ts`, `test/sandbox-read-isolation.test.ts` | opt-in strict read allowlist on Darwin/Linux (`DS_AGENT_SANDBOX_READ_ISOLATION` set to `1`, `true`, or `strict`), no blanket `/` or home read, invalid env fails closed, existing behavior unchanged when off |
| PACKAGING | done (#122 + #160); version surface merged | `package.json`, `tsconfig.build.json`, `scripts/copy-assets.ts`, `scripts/package-smoke.ts`, `scripts/release-check.ts`, `test/packaging.test.ts`, docs | `pnpm build` emits `dist/`, `bin.ds-agent`, `files` allowlist, install/run without `tsx`, package smoke and release checks. `ds-agent --version` / `src/cli/version.ts` landed in #160 |

### W2 — Recall and policy (landed; T48 measurement open)

| Task | Status | Owner files | Acceptance |
|---|---|---|---|
| SEMANTIC-LTM-IMPL | done (#152, `922b3b9`) for hybrid recall; **T48 remains [~]** for month-scale | `src/memory/embedding.ts`, `src/memory/long-term.ts`, memory tests, M6 docs | ADR-010 lexical normalization + synonyms + tag-aware one-hop, held-out queries, 1000-entry bound, ACL preserved; plus hybrid semantic arm behind `EmbeddingPort` with default-on offline `HashedEmbedding`, `DS_AGENT_SEMANTIC_RECALL=0` opt-out, and a cosine floor (`DS_AGENT_EMBEDDING_FLOOR`). No calendar-month measurement exists, so T48 is not claimed |
| MODEL-SLOW-PATH (T17) | done, opt-in (#128 `788be60`; channel wiring #135 `268809d`) | `src/ingress/policy.ts`, `src/ingress/filter.ts`, `src/runtime.ts`, channel loops, tests | rules-only default; `DS_AGENT_SLOW_PATH=model` adds structured-output policy with timeout and `ruleClassify` fallback on timeout/error/invalid output; sync `ingest` and A2A inbound never call the model; offline CI makes no provider call |
| LIVE-BAKEOFF (T45) | measured (#115) | `docs/BAKEOFF.md`, no product code | dated local-Magpie run (2026-11-04T08:44Z): dual 11 calls / 38,805 ms vs single 10 calls / 38,684 ms, `wallRatio=1.0031`; limitations stated |

### W3 — Product shell (landed)

| Task | Status | Owner files | Acceptance |
|---|---|---|---|
| LIFECYCLE-PERSISTENCE | done (#124, `888f810`) | `src/core/lifecycle.ts`, `src/store/schema.ts`, `src/runtime.ts`, `test/lifecycle-persistence.test.ts` | lifecycle events survive restart; bounded replay; schema migration added (v3) |
| LOCAL-UI | done (#129 `123ee40`; command wiring #136 `1e01862`) | `src/ui/server.ts`, `src/cli/main.ts`, `test/cli-ui.test.ts`, docs | `ds-agent ui` binds 127.0.0.1 only, requires a shared token (`DS_AGENT_UI_TOKEN` or `--token`), read-only ticket/thread/outbox/health views, no remote code |
| ONE-UI-MANY-TOPICS | done (#129) | UI read model + lifecycle events | tickets, threads, outbox, and health visible without a Session; speculative tickets filtered; no fake data |

### W4 — Interop and distributed execution (transport landed; listeners owner-gated)

| Task | Status | Owner files | Acceptance |
|---|---|---|---|
| A2A-HTTP + PEER-AUTH | transport **done** (#123 `7a1d732`); **listener owner-gated** | `src/channels/a2a-http.ts`, `src/channels/a2a-auth.ts`, tests | authenticated HTTP transport with signed envelope, timestamp + nonce replay window, size cap, peer identity never trusted from the body, loopback-HTTP or HTTPS only. It exposes a handler and client transport but starts **no listener**; mounting one is an owner/operator decision |
| CROSS-HOST-MESH | registry/heartbeat/dispatch **done** (#130 `d9ded0b`); **listener + local placement wiring owner-gated** | `src/harness/mesh.ts`, `src/harness/remote-node.ts`, tests | node registration/heartbeat, capacity, remote assignment dispatch over the authenticated transport, fail-closed on unknown peer. Starts no listener and is not connected to the in-process placement queue; T47 remote execution is **not** claimed |
| ROUTER-SHARD-MULTI-FILTER (T09/T46) | local **done** (#69, #125 `9216c1b`); remote registration owner-gated | `src/ingress/shards.ts`, `src/runtime.ts`, tests | multiple filters per shard, deterministic priority/registration arbitration, first matching shard owns the reply and terminal decision. Remote shard registration still depends on a mounted A2A listener |
| A2A/UI THREAT MODEL | done (#126 `6db42b7`) | `docs/SECURITY.md` | adversary model, key distribution, rotation, TLS expectations, local-endpoint warning |

### W5 — Operations and release (landed; first release is a human step)

| Task | Status | Acceptance |
|---|---|---|
| BACKUP/RESTORE | done (#131 `d67731a`; usage fix #138 `58c410a`) | documented + tested `ds-agent backup`, `ds-agent restore`, WAL-safe, restore validates source schema version |
| UPGRADE RUNBOOK | done (#131) | `docs/UPGRADE.md`: migration + rollback procedure, supported-version table |
| CONTAINER PROFILE | done (#131) | `docs/CONTAINER.md`: default-deny read profile for workers; distinguishes host policy from this repo's sandbox |
| HEALTH/OBSERVABILITY | done (#127 `e700730`) | `ds-agent health` reports schema version, requested vs enforced read isolation and worker sandbox, and transport mode. It truthfully reports `in-process` A2A/mesh and does not claim a listener |
| RELEASE | tooling done (#131, #132 `a1985c0`); first release **human step** | version bump, CHANGELOG, manual `release.yml` (workflow_dispatch, `contents: read`, no secrets), install smoke in `docs/RELEASE.md`. Tagged publication remains a deliberate human step; there is no npm publish step |

## Sequencing

The original cycle plan has run to completion for everything that does not
require an owner decision. Reconciled against `main`:

1. **Cycle A (landed):** store migrations (#116), opt-in read isolation
   (#117), semantic recall (#152), live bake-off measurement (#115).
2. **Cycle B (landed):** model slow path (#128, #135), packaging build (#122),
   lifecycle persistence (#124).
3. **Cycle C (landed):** local UI (#129, #136); A2A transport + peer auth
   (#123); A2A/UI threat model (#126).
4. **Cycle D (landed except listeners):** remote mesh registry (#130), router
   multi-filter (#125), backup/restore and ops docs (#131), container profile.
5. **Cycle E (partial):** docs reconciliation (this PR). Final live acceptance
   and a first tagged release remain human steps.

Remaining program, in order:

1. Owner decision on mounting the A2A HTTP listener and the remote mesh
   listener. Both are implemented and both deliberately start nothing; T47
   remote execution and exposed A2A are not claimed until an operator mounts
   them with per-peer secrets and TLS.
2. T48 month-scale measurement with dated evidence. No code gap is known; the
   semantic arm is landed, the calendar-month claim is not.
3. Packaging `--version` surface already merged via #160; next is owner-gated mesh/A2A or T48 month-scale
4. First release dispatch (human) per `docs/RELEASE.md`.

Do not mount a new network listener or flip read isolation / model admission
from opt-in to default without an ADR or explicit owner approval, a recorded
smoke test, and a green suite on the exact head.

## Risk gates

| Change | Gate |
|---|---|
| A2A peer authentication, mesh identity, permission model | ADR + explicit owner approval before merge; threat model; replay tests |
| New network listener | bind loopback by default; explicit opt-in for remote; token/TLS required; fail closed |
| Schema migration | additive only unless owner approves destructive; transaction + backup + rollback test |
| Read isolation default | opt-in first; default flip is a separately reviewed PR with container docs |
| Breaking API (e.g. async admission) | opt-in flag or major version; migration notes; owner approval |
| Live model/channel run | credentials present, operator authorization, recorded evidence; never fabricated |
| T48 month-scale claim | dated multi-month measurement or owner re-scope; a default-on embedding is not a substitute |
| Packaging version surface | done via #160 |

## Evidence ledger

Update this table after each merged PR; do not mark a row done from a branch
alone.

| Item | PR | Commit on `main` | Evidence |
|---|---|---|---|
| STORE-MIGRATIONS | #116 | `39ff321` | `src/store/schema.ts` `LATEST_SCHEMA_VERSION = 4` + `schema_migrations`; `test/store-migration.test.ts` |
| HOST-READ-ISOLATION | #117 | `0201b4f` | `src/env/seccomp.ts` strict read roots; `test/sandbox-read-isolation.test.ts`; opt-in only |
| PACKAGING | #122 (version surface: #160 merged) | `c72f514` | `package.json` `bin`/`files`/`build`, `tsconfig.build.json`, `scripts/copy-assets.ts`, `scripts/package-smoke.ts`, `scripts/release-check.ts`, `test/packaging.test.ts` |
| SEMANTIC-LTM-IMPL | #152 | `922b3b9` | `src/memory/embedding.ts` `HashedEmbedding`; `src/memory/long-term.ts`; `test/memory-recall-eval.test.ts`. T48 month-scale still **[~]** |
| LIVE-BAKEOFF | #115 | — | local Magpie run 2026-11-04T08:44Z: dual 11 calls / 38,805 ms vs single 10 calls / 38,684 ms; `wallRatio=1.0031`; summary and raw JSON appendix in `docs/BAKEOFF.md` |
| MODEL-SLOW-PATH | #128, #135 | `788be60`, `268809d` | `src/ingress/policy.ts` `PolicyClassifier`; `RuntimeOptions.slowPath`; opt-in `DS_AGENT_SLOW_PATH=model`; `n-policy`/`n-model` tests |
| LIFECYCLE-PERSISTENCE | #124 | `888f810` | `src/core/lifecycle.ts`; `test/lifecycle-persistence.test.ts`; schema v3 events |
| LOCAL-UI | #129, #136 | `123ee40`, `1e01862` | `src/ui/server.ts`; `test/cli-ui.test.ts`; loopback-only, token required |
| ONE-UI-MANY-TOPICS | #129 | `123ee40` | read model in `src/ui/server.ts` (tickets/threads/outbox/health) |
| A2A-HTTP + PEER-AUTH | #123 | `7a1d732` | `src/channels/a2a-http.ts`, `a2a-auth.ts`; no listener started — **owner-gated** |
| A2A/UI THREAT MODEL | #126 | `6db42b7` | `docs/SECURITY.md` |
| CROSS-HOST-MESH | #130 | `d9ded0b` | `src/harness/remote-node.ts`; no listener, not wired to local placement — **owner-gated** |
| ROUTER-SHARD-MULTI-FILTER (T09/T46) | #69, #125 | `9216c1b` | `src/ingress/shards.ts`; multi-filter + precedence tests; remote registration owner-gated |
| BACKUP/RESTORE | #131, #138 | `d67731a`, `58c410a` | `src/cli/backup.ts`, `src/store/backup.ts`; `test/store-backup.test.ts` |
| UPGRADE RUNBOOK | #131 | `ed9987b` | `docs/UPGRADE.md` |
| CONTAINER PROFILE | #131 | `ed9987b` | `docs/CONTAINER.md` |
| HEALTH/OBSERVABILITY | #127 | `e700730` | `src/watchdog/health.ts`; reports requested vs enforced capabilities and in-process transports |
| RELEASE | #131, #132 | `d67731a`, `a1985c0` | `docs/RELEASE.md`; `.github/workflows/release.yml` (`workflow_dispatch`, `contents: read`, no secrets); publication remains a human step. `docs/DEVELOPMENT_STATUS.md` records #132 as merged outside that session's owner gate; the workflow publishes nothing |
