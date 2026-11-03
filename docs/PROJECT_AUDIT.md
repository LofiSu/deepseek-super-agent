# Project audit — 2026-11-03

> Audit base: `main` at `bb11c96` (`feat: iMessage channel + local
> OpenAI-compatible gateway (#64)`). All commands were run locally on this tree.
> This audit supersedes the stale `fa974ca` evidence in open PR #74.

## 1. Repository state

| Item | Observation |
|------|-------------|
| Branch | `main`, clean working tree |
| HEAD | `bb11c96` |
| Remote | `git@github.com:LofiSu/deepseek-super-agent.git` |
| Open PRs | **#74** only (`docs/final-audit`) |
| Issues | GitHub Issues disabled |
| Branch protection | required check `typecheck and test`; strict; admins enforced; conversation resolution required |
| Node / pnpm | Node v22.23.4 / pnpm 9.15.9 |
| Package scripts | `lint`, `format:check`, `typecheck`, `test`, `test:coverage`, `demo`, `demo:local`, `demo:feishu`, `bench:bakeoff` |

## 2. Verified quality gates

```text
pnpm typecheck                                         exit 0
pnpm lint                                              lint ok (208 tracked files)
pnpm format:check                                      exit 0
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run   372 passed, 15 skipped, 52 files
pnpm test:coverage                                     371 passed, 51 files
                                                       statements 80.68% (7171/8888)
                                                       branches   79.69% (2469/3098)
                                                       functions  89.72% (646/720)
                                                       lines      80.68% (7171/8888)
```

The 15 skips are the live and real-channel suites (`live-*`, `demos-real-channels`).
No live model or real-channel acceptance run was performed in this audit.

## 3. Architecture state

The module boundaries from `PLAN.md` §2 and `docs/DOMAIN_ALIGNMENT.md` are
present in `src/`:

- `src/shared` — types and ports; no business logic.
- `src/harness` — Router/Worker sessions, tools, jobs, team, mesh, daemon.
- `src/core` — Engine, intake, evals, tickets, assignments, replies, lifecycle.
- `src/store` — SQLite source of truth, outbox, jobs, sessions.
- `src/ingress` — admission, shards, batching, thread state.
- `src/channels` — CLI, Feishu, GitHub, A2A, iMessage, outbox adapters.
- `src/env` — isolated workspaces, sanitization, vault, seccomp.
- `src/watchdog` — stuck/drift detection and fail paths.
- `src/memory` — spill-backed long-term memory and recall.
- `src/speculate` — speculative delivery gate.
- `src/metrics` — counters, curves, bake-off.
- `src/gateway` — local OpenAI/Anthropic/Gemini-compatible proxy.
- `src/runtime.ts` — composition root.

The Engine remains the only writer of domain aggregates. `src/harness/loop.ts`
reads tickets and calls `assignmentStarted`; it does not mutate tickets except
through the Engine-owned host callback. The gateway is an infrastructure
surface, not a domain actor.

## 4. Findings

### IMESSAGE-ADMISSION — iMessage admission is default-open

`imessageTrigger()` sets `addressed: 'direct'` for every message. Admission
rules are optional: with none configured, the fast path accepts a `direct`
trigger without any admission, mention, or noise check. `--handle` is optional,
so a default run ingests any sender in any chat, including group chats, and any
party who can message the agent's Apple ID can trigger work. The docs call the handle
"strongly recommended", which is not a boundary. This is being fixed in
`agent/imessage-admission`.

### P1-3 — Worker-mesh capacity is advisory

`Harness.launch` logs `[mesh] ... capacity-full` and runs the Worker anyway.
`WorkerMeshRegistry` correctly reports no free node, but no scheduler consumes
that signal. With `DS_AGENT_MESH_CAPACITY=1`, two Workers can run concurrently.
This is being fixed in `agent/P1-3-mesh-backpressure`.

### P1-6 — No restart replay

`Runtime.start` starts the daemon and pending assessments but does not scan for
interrupted assignments. A killed process leaves an assignment `running` until
the watchdog (or forever if the watchdog is not run). `serve` explicitly
documents that in-flight turns are not reconstructed. This is scheduled after
the mesh change because both touch `Harness.launch`/`drain` and runtime release.

### GATEWAY-HARDENING — Gateway auth/exposure edges

- Bearer token comparison is `===`, not constant-time.
- An empty token is accepted at server start (all requests with `Bearer ` may
  then pass depending on header parsing).
- `/`, `/ui`, `/health` are unauthenticated; `/health` exposes provider IDs,
  plugin names, and metrics.
- A non-loopback `--host` bind is accepted without an exposure warning.
- A pre-existing token file is reused without re-applying `0600`.
- The dashboard is read-only and does not embed the token; that part is sound.

### GATEWAY-REVIEW — #64 review recorded; hardening and coverage remain

`#64` added 4,390 lines and 13 test files after the last roadmap audit. Coverage
on the merged tree is 80.68% lines / 79.69% branches. The 82.40% figure recorded
for `fa974ca` is a historical baseline, not a target. The independent review and
verdict are recorded in `docs/PR_REVIEW_LOG.md`. Remaining work is iMessage
admission and gateway hardening, plus focused coverage for security-relevant
gateway/iMessage branches.

### SERVE-CHANNEL-LOOP — `serve` has no inbound channel loop

`ds-agent serve` drains persisted work and runs assessments, but does not poll
Feishu/GitHub/iMessage. Triggers written by another process are not picked up.
This is documented; it remains a production limitation rather than a bug.

## 5. Live/operator-only evidence (not reproduced)

- `docs/MODULES.md` records a live Magpie run of 207 passed / 3 skipped. That
  line remains operator-only and is not reproduced here (roadmap P1-9).
- `pnpm demo` (real GitHub issues/comments) requires operator `gh` auth and a
  live model. It was not run.
- `pnpm demo:feishu` requires real Feishu credentials. It was not run.

## 6. Audit conclusion

The offline gate is green and the architecture still matches its contracts. The
highest-value work is not new features: it is closing the default-open iMessage
admission path, making mesh capacity real, adding restart recovery, and
reviewing/hardening the newly merged gateway surface.
