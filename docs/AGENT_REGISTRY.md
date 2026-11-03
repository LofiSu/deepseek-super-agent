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
| IMESSAGE-GROUP-EDGES | Infrastructure/Security | `agent/imessage-group-edge-tests` | 2026-11-03 | implementing | — | in progress |
| GATEWAY-TOKEN-RACE | Infrastructure/Security | `agent/gateway-token-race` | 2026-11-03 | implementing | — | in progress |
| GATEWAY-REVIEW | QA/Review | review only | — | #76/#81/#82/#84/#85 APPROVE; #77 corrected | — | continuing |

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
