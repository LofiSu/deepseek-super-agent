# Four-PR workflow progress (M3 / M1 / M6 / M10)

> Checkpoint: 2026-11-08. `main` unchanged for #163; open implementation PRs #164–#167.
> Offline gate command:
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
| [#164](https://github.com/LofiSu/deepseek-super-agent/pull/164) | `feat/m3-recovery-boundary-os-fault` | `main` | `7bc212199f76c360bac4a644732e7e126a30c215` | **pass** (run `42393403924`) | **97** files pass, **3** skipped (100); **924** passed, **16** skipped (940) |
| [#165](https://github.com/LofiSu/deepseek-super-agent/pull/165) | `feat/m1-remote-mesh-runtime-path` | `main` | `b53bd029b3b3c56544aa17b893e819b4b2584f71` | **pass** (run `42395066240`) | **99** / **3** (102); **931** / **16** (947) |
| [#166](https://github.com/LofiSu/deepseek-super-agent/pull/166) | `feat/m6-t48-longitudinal-harness` | `main` | `ffffbf3bfe049024997864b0c834dbc81df945e4` | **pass** (run `42395935808`) after EOF fix | **96** / **3** (99); **923** / **16** (939) |
| [#167](https://github.com/LofiSu/deepseek-super-agent/pull/167) | `feat/m10-deployment-security` | `main` | `9c3ad44aba8630ceccd452764f1e3f8271cf440c` | **pass** (run `42395066250`) | **97** / **3** (100); **930** / **16** (946) |

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

### #165 / #166 / #167 fix heads

- **#165 `b53bd02`**: `RemoteMeshResultWait`, host integration tests, honest note
  that abrupt OS-level worker disconnect is not fully simulated.
- **#167 `9c3ad44`**: sandbox write probe honesty (no false-positive
  “enforced”), injectable fake wrapper regression.
- **#166 `ffffbf3`**: removed trailing blank line at EOF of
  `test/t48-wall-clock-observe.test.ts` (CI `git diff --check` failure).

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

No routine/cron is created by this repo — schedule externally (e.g. daily
`systemd`/`cron` invoking the same env block).

## Feasible coding acceptance vs remaining gaps

| Area | Status on these PR heads |
|------|--------------------------|
| M3 recovery boundary + OS-fault restart tests (#164) | **done** for scoped acceptance tests |
| M1 in-process remote mesh placement + result wait (#165) | **partial [~]** for T47: runtime wiring and wait/timeout landed; **not** full production cross-host lifecycle (listeners owner-gated per `docs/PRODUCTION_PROGRAM.md` W4) |
| Mesh queue **backpressure** (local worker capacity) | **done** — `test/worker-mesh.test.ts` “P1-3” |
| **Cancel** + remote **capability matching** on reassignment | **partial [~]** — capacity/registry accounting tested; explicit cancel-on-mismatch / remote capability filter not a closed acceptance story on these heads |
| Supported channel **reconnect / backpressure lifecycle** (Feishu/iMessage serve) | **partial [~]** — serve loops and gateway recovery exist on `main`; dedicated reconnect/backpressure acceptance for supported channels is **not** fully implemented in #164–#167 |
| M6 longitudinal journal + wall-clock observer (#166) | **done** for persistent fixture store + process re-run tests; **not** month-scale T48 complete |
| M10 loopback deployment / sandbox probe honesty (#167) | **done** for documented probe scope |
| Real elapsed T48 / physical multi-week machine | **future validation** (legitimate, not confused with above coding gaps) |

## Local gates re-run (evidence)

On each PR worktree after final heads: `pnpm typecheck`, `pnpm lint`,
`DS_AGENT_FORMAT_BASE=origin/main pnpm format:check` — **clean** on #165–#167
and on #166 after `ffffbf3`.
