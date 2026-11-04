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
| MESH-FAILURE-PUMP | Orchestration | `agent/mesh-failure-pump` | 2026-11-03 | merged `6184a27`, APPROVE | #99 | integrated |
| SERVE-CHANNEL-LOOP | Core Runtime | `agent/serve-imessage-loop` | 2026-11-04 | merged `2ae9740` | #101 | integrated |
| OUTBOX-PERMANENT-FAILURE | Core Runtime | `agent/outbox-permanent-failure` | 2026-11-04 | merged `55f0d09` | #100 | integrated |
| SUBSCRIPTION-FANOUT-TEST | QA/Testing | `debug/subscription-timeout` | 2026-11-04 | merged `5e5a28b` | #103 | integrated |
| CYCLE-5-CHECKPOINT | Chief Engineer | `docs/cycle-5-checkpoint` | 2026-11-04 | merged `ab8e4bf` (docs; follow-up adds ADR-008/audit) | #98 | integrated |
| CYCLE-5-CHECKPOINT-FOLLOWUP | Chief Engineer (peer) | `docs/cycle-5-checkpoint-followup` | 2026-11-04 | merged `55f3e7b`, docs APPROVE | #102 | integrated |
| CYCLE-6-CHECKPOINT | Chief Engineer | `docs/cycle-6-checkpoint` | 2026-11-04 | merged `3bdb90a`, docs APPROVE | #104 | integrated |
| FEISHU-SERVE-LOOP | Core Runtime | `agent/feishu-serve-loop` | 2026-11-04 | merged `e9a1978`, APPROVE | #106 | integrated |
| STALE-GATEWAY-TOKEN | Infrastructure/Security | `agent/stale-gateway-token-adr` | 2026-11-04 | merged `69b6d3d`, docs APPROVE after correction | #105 | integrated; code follow-up in #109 |
| STALE-GATEWAY-TOKEN-FOLLOWUP | Infrastructure/Security | `agent/stale-gateway-token-followup` | 2026-11-04 | merged `064ab06`, APPROVE | #109 | integrated |
| IMESSAGE-GROUP-UNKNOWN | Infrastructure/Security (peer) | `agent/imessage-group-unknown` | 2026-11-04 | merged `00665d2`, reviewed APPROVE | #107 | integrated |
| CYCLE-7-CHECKPOINT | Chief Engineer | `docs/cycle-7-checkpoint` | 2026-11-04 | merged `6e19bca`, docs APPROVE | #108 | integrated |
| CYCLE-8-CHECKPOINT | Chief Engineer | `docs/cycle-8-checkpoint` | 2026-11-04 | merged `5141e29`, docs APPROVE | #110 | integrated |
| SEMANTIC-LTM | Model/Intelligence | `agent/semantic-ltm-evaluation` | 2026-11-04 | merged `f6e5972`, APPROVE | #112 | integrated; follow-up implementation open |
| CYCLE-9-CHECKPOINT | Chief Engineer | `docs/cycle-9-checkpoint` | 2026-11-04 | docs update; PR under review | — | in progress |
| GATEWAY-REVIEW | QA/Review | review only | — | #76/#81/#82/#84/#85/#87/#90/#95/#96/#97/#99/#100/#101/#103/#105/#106/#107/#109/#112 APPROVE; #77 corrected | — | continuing |
| A2A-HTTP-AUTH | Infrastructure/Security | `agent/a2a-http-auth` | 2026-11-04 | merged `7a1d732`, security APPROVE | #123 | integrated |
| LIFECYCLE-PERSISTENCE | Core Runtime | `agent/lifecycle-persistence` | 2026-11-04 | merged `888f810`, schema v3/replay APPROVE | #124 | integrated |
| SECURITY-THREAT-MODEL | Infrastructure/Security | `docs/security-threat-model` | 2026-11-04 | merged `6db42b7`, docs APPROVE after status/citation fixes | #126 | integrated; updated by this PR for merged UI/mesh |
| HEALTH-OBSERVABILITY | Core Runtime | `agent/health-observability` | 2026-11-04 | merged `e700730`, APPROVE | #127 | integrated |
| MODEL-SLOW-PATH | Model/Intelligence | `agent/model-slow-path` | 2026-11-04 | merged `788be60`, APPROVE after sanitization/duplicate fixes | #128 | integrated; channel wiring in #135 |
| CROSS-HOST-MESH | Orchestration/Security | `agent/cross-host-mesh` | 2026-11-04 | merged `d9ded0b`, APPROVE after SSRF/bound/callback fixes | #130 | integrated; no default listener |
| OPS-BACKUP-RELEASE | Infrastructure/QA | `agent/ops-release` | 2026-11-04 | merged `d67731a`, APPROVE after restore/race/integrity fixes | #131 | integrated; release workflow #132 owner-gated |
| LOCAL-UI | Product/UI | `agent/local-ui` | 2026-11-04 | merged `123ee40`, APPROVE after token/spec/metrics/SSE fixes | #129 | integrated |
| CHANNELS-COMBINED | Core Runtime | `agent/channels-feishu-imessage` | 2026-11-04 | merged `0cdea17`, APPROVE | #133 | integrated |
| CHANNEL-SLOW-PATH | Core Runtime | `agent/channel-slow-path` | 2026-11-04 | merged `268809d`, APPROVE after spy update | #135 | integrated |
| CLI-WIRING | Chief Engineer/CLI | `agent/cli-command-wiring` | 2026-11-04 | squash-merged `1e01862`; usage accuracy split to #138, merged `58c410a` | #136/#138 | integrated |

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
- MESH-FAILURE-PUMP: `src/harness/loop.ts`, `test/worker-mesh.test.ts` (after
  #97; merged #99).
- LIVE-SUITE-SALVAGE: `test/credential-sentinel.test.ts`, `test/fixtures.ts`,
  `test/metrics.test.ts`, `test/team-live.test.ts` (merged #91).
- SERVE-CHANNEL-LOOP: `src/cli/imessage.ts`, `src/cli/main.ts`, a new
  `src/cli/channel-loop.ts` if needed, `test/cli-serve-imessage.test.ts` (new),
  `docs/IMESSAGE.md`. Must not modify `src/channels/imessage.ts`; the existing
  `ImessageSource`/`ImessageApi` exports are the seam.
- OUTBOX-PERMANENT-FAILURE: `src/channels/outbox-adapter.ts`,
  `src/channels/imessage.ts` (adapter error only), `test/outbox*.test.ts`,
  `test/channels-imessage.test.ts`, `docs/MODULES.md` M4.
- SUBSCRIPTION-FANOUT-TEST: `test/subscription.test.ts` only (merged #103).
- FEISHU-SERVE-LOOP: `src/cli/feishu.ts` (new), `src/cli/main.ts`,
  `src/channels/feishu.ts` (cursor accessor only), `test/cli-serve-feishu.test.ts`
  (new), `docs/REAL_CHANNELS.md`, `docs/MODULES.md` M11 (merged #106).
- STALE-GATEWAY-TOKEN: `docs/ARCHITECTURE_DECISIONS.md`, `docs/GATEWAY.md`
  (docs-only ADR-009; merged #105).
- STALE-GATEWAY-TOKEN-FOLLOWUP: `src/gateway/token.ts`,
  `test/gateway-token.test.ts`, `docs/GATEWAY.md`,
  `docs/ARCHITECTURE_DECISIONS.md` (merged #109).
- SEMANTIC-LTM: `docs/ARCHITECTURE_DECISIONS.md` (ADR-010),
  `docs/MODULES.md` M6, `docs/ROADMAP.md` M6/T48,
  `test/memory-recall-eval.test.ts` (new; merged #112). No product source.
  The follow-up owns `src/memory/long-term.ts` and its memory tests.
- IMESSAGE-GROUP-UNKNOWN: `src/channels/imessage.ts`,
  `test/channels-imessage.test.ts`, `docs/IMESSAGE.md` (merged #107).
- The cycle-7 tasks are disjoint; only the shared `docs/MODULES.md` would have
  collided, so the ADR task was kept docs-only and out of it.
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
