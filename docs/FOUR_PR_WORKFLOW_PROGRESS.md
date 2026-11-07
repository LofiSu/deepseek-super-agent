# Four-PR workflow progress (M3 / M1 / M6 / M10)

> Checkpoint: 2026-11-08. `main` unchanged; open implementation PRs **#164–#167**.
> **[#163](https://github.com/LofiSu/deepseek-super-agent/pull/163)** (`feat/health-sandbox-enforcement-probe`) remains open on the remote branch but is **omitted** from the four-PR integration stack on purpose (narrower M10 health probe; superseded in scope by #167 deployment/sandbox probes).
> Offline gate command (no exclusions):
> `CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 bash -o pipefail -c 'pnpm test'`

## Co-author trailer violation (historical, not rewritten)

Commits **`b53bd029`** (PR #165) and **`9c3ad44a`** (PR #167) were pushed with
`Co-Authored-By: Claude Code <noreply@anthropic.com>` despite an explicit
no-coauthors constraint. Those objects were **not** amended, rebased, or
force-pushed. Commit **`ffffbf3b`** (PR #166 format fix) and this document use
**no** co-author trailers.

## PR matrix

| PR | Branch | Base | Head | `typecheck and test` | Local full suite (pipefail) |
|----|--------|------|------|----------------------|-----------------------------|
| [#164](https://github.com/LofiSu/deepseek-super-agent/pull/164) **M3** | `feat/m3-recovery-boundary-os-fault` | `main` | **`9c34349033d6d22370a43e420e5b271edf16fd41`** | re-run CI on head | **100** / **3** (103); **929** / **16** (945) pipefail |
| [#165](https://github.com/LofiSu/deepseek-super-agent/pull/165) **M1** | `feat/m1-remote-mesh-runtime-path` | `main` | **`a19879f52ea2c818bd7fc52f946ce8e164db3ba6`** | re-run CI on head | **101** / **3** (104); **935** / **16** (951) pipefail |
| [#166](https://github.com/LofiSu/deepseek-super-agent/pull/166) **M6** | `feat/m6-t48-longitudinal-harness` | `main` | **`ec75f7f93a2c44b36a26e173b17f70dfb5f6e715`** | re-run CI on head | **97** / **3** (100); **926** / **16** (942) pipefail |
| [#167](https://github.com/LofiSu/deepseek-super-agent/pull/167) **M10** | `feat/m10-deployment-security` | `main` | **`f1499fbcdeab7ce0ee1e7f82e2c61789c627d7bb`** | re-run CI on head | **101** / **3** (104); **947** / **16** (963) pipefail |
| **integration** `integration/final-167-m10` | (merges #164+#165+#166+#167 tips) | `main` | **`5c78019f4f89c48fe14b5d93ff2adee5e016b13e`** | local only | **117** / **3** (120); **980** / **16** (996) pipefail |

`demo fixture smoke` is **skipped** on all four (CI dependency: `typecheck and test`).

### Skip reasons (full `pnpm test`, all branches)

| Skipped file | Reason |
|--------------|--------|
| `test/live-e2e.test.ts` | entire file (7 tests) — no live provider / real-channel creds |
| `test/demos-real-channels.test.ts` | entire file (3 tests) — `DS_AGENT_REAL_CHANNELS` not set |
| `test/team-live.test.ts` | entire file (2 tests) — live team fixture |
| `test/live-demo.test.ts` | 3 of 4 tests — live model path |
| `test/sandbox-read-isolation.test.ts` | 1 test — platform-only strict sandbox |

`test/live-modules.test.ts` is **not** excluded; it runs under
`DS_AGENT_ALLOW_MOCK_FIXTURE=1` like CI.

### Current tip SHAs (authoritative mapping)

- **#164 M3 `9c34349`**: `finishOutboxSendOperation` after successful/terminal outbox send (no spurious `unknown_outcome` on restart); docs `RECOVERY_UNKNOWN_OUTCOME.md` operator retry semantics.
- **#164 M3 `7009aeb`** (prior): recovery-boundary docs + OS-fault delegate tests (includes `59a5355` runtime.create fix).
- **#165 M1 `a19879f`**: format/EOF hygiene atop remote mesh + cancel path (`2d8ead0` feature work).
- **#166 M6 `ec75f7f`**: EOF format fix on T48 observer + persistent store (`fb72685` corpus harness).
- **#167 M10 `f1499fb`**: resident `ingestResidentTrigger` backpressure in `runFeishuLoop` / `runImessageLoop`; Linux `unsharePid` on effective LocalEnv when `process` required; process probe uses effective policy (not probe-only `unsharePid`); `test/channel-resident-gate.test.ts`, deployment serve E2E.
- **#167 M10 `eeb0245`** (prior): required sandbox gate aligned with `LocalEnv` effective policy (after `06691c2` / `daaae12` loopback probe fixes); CI green on `42402569894`.

### `live-modules.test.ts` on integration

Under `CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1`, all **11** cases in `test/live-modules.test.ts` run (MockModel path). On `integration/final-167-m10` @ `c01bd0b`, three consecutive full-suite and isolated-file runs **passed** (2026-11-08). Earlier **953** passed / **966** total counts reflected per-PR heads before M1/M3 mesh and deployment tests landed on the integration branch (**972** passed / **988** total as of this checkpoint).

## T48 wall-clock observe (coding harness; not month acceptance)

Protocol: `docs/T48_MONTH_SCALE_PROTOCOL.md`. T48 remains **`[~]`** until a
real calendar-month corpus exists; wall-clock rows set `syntheticClock: false`
and **`syntheticWorkload: true`** (fixture corpus persists under `DS_AGENT_HOME`).

**Reproducible operator command** (persistent home; default cadence **24h**;
`DS_AGENT_T48_OBSERVE_FORCE=1` for an immediate sample without waiting):

```bash
mkdir -p /workspace/ds-agent-longitudinal/.ds-agent/measurement/t48-journal
cd /path/to/deepseek-super-agent   # branch feat/m6-t48-longitudinal-harness
DS_AGENT_HOME=/workspace/ds-agent-longitudinal \
DS_AGENT_T48_JOURNAL_DIR=.ds-agent/measurement/t48-journal \
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 \
DS_AGENT_T48_OBSERVE_FORCE=1 \
pnpm t48:observe
```

Journal default file:
`/workspace/ds-agent-longitudinal/.ds-agent/measurement/t48-journal/t48-measurements.jsonl`

Wall-clock state file:
`/workspace/ds-agent-longitudinal/.ds-agent/measurement/t48-wall-clock-state.json`

**First observation after M6 head `ec75f7f`** (existing on disk; no new sample forced for this gate): **1** journal row, **`samples`: 1**, `lastSampleAt` `2026-11-07T18:08:53.173Z`, `corpusSamplesInserted`: 1, `syntheticClock`: false, `syntheticWorkload`: true. Stable operator entrypoint: `pnpm t48:observe` with `DS_AGENT_HOME=/workspace/ds-agent-longitudinal` and optional `DS_AGENT_T48_JOURNAL_DIR=.ds-agent/measurement/t48-journal` (see command block above).

No routine/cron is created by this repo — schedule externally (e.g. daily
`systemd`/`cron` invoking the same env block).

## Feasible coding acceptance vs remaining gaps

| Area | Status on these PR heads |
|------|--------------------------|
| M3 recovery boundary + OS-fault restart tests (#164) | **done** for scoped acceptance tests |
| M1 in-process remote mesh placement + cancel + result wait (#165) | **partial [~]** for T47: dispatch/cancel/result on loopback child; **not** full production cross-host lifecycle (listeners owner-gated per `docs/PRODUCTION_PROGRAM.md` W4) |
| Mesh queue **backpressure** (local worker capacity) | **done** — `test/worker-mesh.test.ts` “P1-3” |
| **Cancel** + remote **capability matching** on reassignment | **partial [~]** — **#165 `2d8ead0`**: HTTP `assignment_cancel` at OS child boundary + late-result suppression; capability filter / reassignment mismatch still open |
| Supported channel **reconnect / backpressure lifecycle** (Feishu/iMessage serve) | **done** on #167 — exponential poll backoff + abortable sleep (`channel-loop.ts` / `feishu.ts`); bounded resident ingress via `channel-resident-gate.ts` + `DS_AGENT_RESIDENT_INGRESS_LIMIT`; `test/deployment-serve-resident-e2e.test.ts` and `test/channel-resident-gate.test.ts` |
| M6 longitudinal journal + wall-clock observer (#166) | **done** for persistent fixture store + process re-run tests; **not** month-scale T48 complete |
| M10 loopback deployment / sandbox probe honesty (#167) | **done** for documented probe scope |
| Real elapsed T48 / physical multi-week machine | **future validation** (legitimate, not confused with above coding gaps) |

## Local gates re-run (evidence)

2026-11-08 on integration **`5c78019`** and per-PR tips **`9c34349`** (M3), **`f1499fb`** (M10):
`pnpm typecheck`, `pnpm lint`, `DS_AGENT_FORMAT_BASE=origin/main pnpm format:check` — **clean** on integration;
`CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 bash -o pipefail -c 'pnpm test'` — **980** passed / **16** skipped (**996** total), **117** files passed / **3** skipped on integration.
