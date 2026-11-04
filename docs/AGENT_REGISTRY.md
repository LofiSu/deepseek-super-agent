# Agent registry

> Coordination record for the 2026-11-03 execution cycle. Agent identities are
> task IDs, not vendor account names. Update this file when a task is dispatched,
> blocked, reviewed, merged, or abandoned. The main session is the only
> orchestrator; at most 3 implementation agents run while the pipeline is
> validated.

## Roles

| Role | Responsibility |
|------|----------------|
| Chief Engineer | Audit, plan, dispatch, independent review, merge, state reconciliation |
| Principal Architecture Engineer | Boundary review, interface changes, ADRs |
| Core Runtime Engineer | Harness, jobs, sessions, recovery, shutdown |
| Orchestration Engineer | Mesh, teams, parallelism, cancellation, backpressure |
| Model/Intelligence Engineer | Provider routing, context, prompts, memory |
| Infrastructure/Security Engineer | Sandbox, permissions, credentials, gateway |
| QA/Testing Engineer | Unit/integration/E2E, coverage, failure injection |

## Active agents

| Task | Role | Branch | Start | Checkpoint | PR | Status |
|------|------|--------|-------|------------|----|--------|
| IMESSAGE-ADMISSION | Infrastructure/Security | `agent/imessage-group-aggregation` | 2026-11-03 | #81 merged, APPROVE | #81 | integrated |
| P1-3 | Orchestration | `agent/P1-3-mesh-backpressure` | 2026-11-03 | #79 merged with blocking review | #79 | integrated; corrected by #84 |
| MESH-RELEASE-ORDER | Orchestration | `agent/mesh-release-order` | 2026-11-03 | #84 merged, APPROVE | #84 | integrated |
| GATEWAY-HARDENING | Infrastructure/Security | `agent/gateway-hardening` | 2026-11-03 | merged | #76 | integrated |
| GATEWAY-TOKEN-SYMLINK | Infrastructure/Security | `agent/GATEWAY-TOKEN-SYMLINK` | 2026-11-03 | #82 merged, APPROVE | #82 | integrated |
| AUDIT-REFRESH | Chief Engineer | `docs/final-audit` | 2026-11-03 | merged `299b908`, APPROVE | #74 | integrated |
| P1-6 | Core Runtime | `agent/P1-6-restart-recovery` | 2026-11-03 | merged `10e9f3c`, APPROVE | #85 | integrated |
| IMESSAGE-GROUP-EDGES | Infrastructure/Security | `agent/imessage-group-edge-tests` | 2026-11-03 | merged `d3beb9c`, APPROVE after fix `890f238` | #88 | integrated |
| GATEWAY-TOKEN-RACE | Infrastructure/Security | `agent/gateway-token-race` | 2026-11-03 | merged `5fbfb00`, security APPROVE | #87 | integrated |
| STATE-DOCS | Chief Engineer | `docs/cycle-3-status` | 2026-11-03 | merged `ed8980d`, APPROVE after corrections | #89 | integrated |
| IMESSAGE-THREAD-KEY | Infrastructure/Security | `agent/imessage-thread-key` | 2026-11-03 | merged `8fa3a79`, APPROVE | #90 | integrated |
| LIVE-SUITE-SALVAGE | QA/Testing | `test/live-suite-salvage` | 2026-11-03 | merged `1dd426a`, APPROVE; #86 closed | #91 | integrated |
| MESH-QUEUE-TESTS | Orchestration | `agent/mesh-queue-tests` | 2026-11-03 | merged `60bb9ae`, APPROVE | #92 | integrated |
| CYCLE-4-CHECKPOINT | Chief Engineer | `docs/cycle-4-checkpoint` | 2026-11-03 | merged `d539e25`, APPROVE after correction | #93 | integrated |
| METRICS-ASSERTIONS | QA/Testing | `agent/metrics-assertions` | 2026-11-03 | merged `f8554cc`, APPROVE | #95 | integrated |
| GATEWAY-TOKEN-TESTS | Infrastructure/Security | `agent/gateway-token-tests` | 2026-11-03 | merged `ac1fd79`, APPROVE | #96 | integrated |
| MESH-ASYNC-RELEASE | Orchestration | `agent/mesh-async-release` | 2026-11-03 | merged `9a0def3`, APPROVE | #97 | integrated |
| SERVE-CHANNEL-LOOP | Core Runtime | `agent/serve-imessage-loop` | 2026-11-04 | merged `2ae9740`, APPROVE after docs correction | #101 | integrated |
| OUTBOX-PERMANENT-FAILURE | Core Runtime | `agent/outbox-permanent-failure` | 2026-11-04 | merged `55f0d09`, APPROVE | #100 | integrated |
| MESH-FAILURE-PUMP | Orchestration | `agent/mesh-failure-pump` | 2026-11-04 | merged by peer session `6184a27`, reviewed APPROVE | #99 | integrated |
| CYCLE-5-CHECKPOINT | Chief Engineer | `docs/cycle-5-checkpoint` | 2026-11-04 | merged `ab8e4bf`, docs APPROVE | #98 | integrated |
| CYCLE-6-CHECKPOINT | Chief Engineer | `docs/cycle-6-checkpoint` | 2026-11-04 | docs update; PR under review | — | in progress |
| GATEWAY-REVIEW | QA/Review | review only | — | #76/#81/#82/#84/#85/#87/#90/#95/#96/#97/#99/#100/#101 APPROVE; #77 corrected | — | continuing |

## Ownership boundaries

- IMESSAGE-ADMISSION: `src/channels/imessage.ts`, `src/cli/imessage.ts`,
  `src/cli/main.ts` (usage line only), `test/channels-imessage.test.ts`,
  `docs/IMESSAGE.md`.
- P1-3: `src/harness/loop.ts`, `src/harness/mesh.ts`, `src/core/host.ts`,
  `src/core/assignments.ts`, `src/core/engine.ts`, `src/runtime.ts`,
  `src/metrics/metrics.ts`, `test/worker-mesh.test.ts`,
  `test/runtime-integration.test.ts`, `docs/MODULES.md`, `docs/ROADMAP.md`.
- GATEWAY-HARDENING: `src/gateway/server.ts`, `src/gateway/token.ts`,
  `src/cli/gateway.ts`, `src/gateway/web.ts`, gateway tests, `docs/GATEWAY.md`.
- GATEWAY-TOKEN-SYMLINK: `src/gateway/token.ts`, `test/gateway.test.ts`,
  `docs/GATEWAY.md`.
- GATEWAY-TOKEN-RACE: `src/gateway/token.ts`, `test/gateway-token.test.ts`,
  `test/cli-gateway.test.ts` (after #82 and the #87 merge).
- IMESSAGE-GROUP-EDGES: `src/channels/imessage.ts`,
  `test/channels-imessage.test.ts`, `docs/IMESSAGE.md` (after #81; merged #88).
- IMESSAGE-THREAD-KEY: the same three iMessage files (after #88; merged #90).
- MESH-QUEUE-TESTS: `src/harness/loop.ts`, `test/worker-mesh.test.ts` (after
  #84; merged #92).
- LIVE-SUITE-SALVAGE: `test/credential-sentinel.test.ts`, `test/fixtures.ts`,
  `test/metrics.test.ts`, `test/team-live.test.ts` (merged #91).
- SERVE-CHANNEL-LOOP: `src/cli/imessage.ts`, `src/cli/main.ts`, a new
  `src/cli/channel-loop.ts` if needed, `test/cli-serve-imessage.test.ts` (new),
  `docs/IMESSAGE.md`. Must not modify `src/channels/imessage.ts`; the existing
  `ImessageSource`/`ImessageApi` exports are the seam.
- OUTBOX-PERMANENT-FAILURE: `src/channels/outbox-adapter.ts`,
  `src/channels/imessage.ts` (adapter error only), `test/outbox*.test.ts`,
  `test/channels-imessage.test.ts`, `docs/MODULES.md` M4.
- The two cycle-6 tasks have disjoint product files: only `docs/IMESSAGE.md`
  is shared, and it belongs to SERVE-CHANNEL-LOOP. OUTBOX-PERMANENT-FAILURE
  must not edit it; the orchestrator cross-links the outbox note at merge.
- STATE-DOCS: the seven project-state docs on `docs/cycle-3-status`; the cycle-4
  checkpoint uses `docs/cycle-4-checkpoint`.
- AUDIT-REFRESH: `docs/ROADMAP.md`, `docs/MODULES.md` (after P1-3 merges).
- State reconciliation: the seven project-state docs in this PR.
- No two active agents may edit the same file. If a shared interface change is
  needed, stop and route it to the Chief Engineer.

## Failure handling

- A stalled agent: inspect its report file and branch; check `git log` and
  `gh pr view` before restarting. Never re-run a task that already committed.
- A failed agent: record the failure here, reassign with a narrower brief, and
  preserve any pushed branch.
- A rejected PR: return findings to the original agent; re-review the fix commit.
  Never let an implementer merge its own PR.
- A merged PR with an open blocking finding is a process incident: open a
  corrective PR immediately and record the incident in `docs/AGENT_LOG.md`.
  PR #77 is the current example.
