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
| IMESSAGE-ADMISSION | Infrastructure/Security | `agent/imessage-admission` | 2026-11-03 | review REQUEST_CHANGES; fix dispatched | #77 | fixing |
| P1-3 | Orchestration | `agent/P1-3-mesh-backpressure` | 2026-11-03 | implementer complete | #79 | review pending |
| GATEWAY-HARDENING | Infrastructure/Security | `agent/gateway-hardening` | 2026-11-03 | independent review APPROVE | #76 | ready to integrate |
| GATEWAY-TOKEN-SYMLINK | Infrastructure/Security | not created | — | follow-up to #76 | — | queued |
| AUDIT-REFRESH | Chief Engineer | `docs/final-audit` | 2026-11-03 | PR #74 open, stale | #74 | blocked on P1-3 |
| P1-6 | Core Runtime | `agent/P1-6-restart-recovery` | — | blocked on P1-3 | — | blocked |
| GATEWAY-REVIEW | QA/Review | review only | — | #76 reviewed; #77 reviewed | — | continuing |

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
  `docs/GATEWAY.md` (after #76 merges).
- AUDIT-REFRESH: `docs/ROADMAP.md`, `docs/MODULES.md` (after P1-3 merges).
- No two active agents may edit the same file. If a shared interface change is
  needed, stop and route it to the Chief Engineer.

## Failure handling

- A stalled agent: inspect its report file and branch; check `git log` and
  `gh pr view` before restarting. Never re-run a task that already committed.
- A failed agent: record the failure here, reassign with a narrower brief, and
  preserve any pushed branch.
- A rejected PR: return findings to the original agent; re-review the fix commit.
  Never let an implementer merge its own PR.
- A review finding that is not a blocker is recorded as a follow-up; it does not
  silently disappear.
