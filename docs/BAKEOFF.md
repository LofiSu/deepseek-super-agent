# Live bake-off — 2026-11-04

> Operator-run measurement of the dual-layer (Router + Worker) versus
> single-Session path, using the shipped `pnpm bench:bakeoff`. This is one
> dated sample, not a benchmark; see **Limitations** before quoting it.

## Environment

| Field | Value |
|---|---|
| Baseline | `main` = `af834b7` |
| Date (UTC) | 2026-11-04T08:44Z |
| Machine | macOS (Darwin 25.6.0), Node v22.23.4 |
| Provider | Local Magpie OpenAI-compatible gateway, `http://127.0.0.1:3425/v1` |
| Model | `workbuddy/deepseek-v4.1-flash` |
| Command | `pnpm bench:bakeoff` from a clean worktree at `origin/main` |
| Scenario | One IM trigger: `@ds-agent please fix the login timeout on checkout` |
| Harness settings | `jobDelayMs=20`, `watchdogIntervalMs=60_000`, deadline 60 s |
| Credentials | Local gateway token only; no value is recorded in this document |

## Results

| Metric | Dual layer | Single Session |
|---|---:|---:|
| Model calls | 11 | 10 |
| Tickets | 1 | 1 |
| Eval accepts | 1 | 1 |
| Wall time | 38,805 ms | 38,684 ms |
| Tickets per model call | 0.091 | 0.100 |

Derived comparison: `extraModelCalls = 1`, `wallRatio = 1.0031`, verdict
`dual paid 1 extra model call(s) for Router sequencing`.

The dual run used a separate `router` Session plus `worker_ticket_1`; the
single run used one Session and logged `single-session router turn skipped`.
Both runs acknowledged the trigger, created one ticket, accepted one Eval, and
delivered the worker's report. The full JSON is reproduced by the command
below; the numbers above are the program's own `compareBakeoff` output.

## Interpretation

- The dual layer costs one extra model call in this scenario: the Router turn
  that sequences/assesses the trigger. That is the expected architectural
  price of the Router-as-sequence-point design.
- Wall time was effectively identical in this single sample (0.3% difference).
  The extra Router call did not translate into a measurable latency penalty
  here, but one ticket is far too small to generalize.
- Both modes produced the same ticket/eval counts, so the comparison is not
  measuring a different workload.

## Limitations

- **One sample, one ticket, one provider.** No confidence interval and no
  multi-ticket or multi-thread workload; do not present this as a throughput
  benchmark.
- **Local gateway.** The model is served by a local Magpie instance, not a
  remote provider; network and rate-limit behavior differ.
- **No real channel.** The trigger is synthetic; this is not the GitHub/Feishu
  acceptance path.
- **Wall time includes setup**, not only model latency.
- **Model nondeterminism.** A repeated run will produce different token usage
  and may produce different tool-call counts.
- The benchmark is not part of CI and does not prove production readiness.

## Reproduce

```bash
git worktree add /tmp/ds-agent-bakeoff --detach origin/main
cd /tmp/ds-agent-bakeoff
pnpm install --frozen-lockfile
DS_AGENT_API_BASE=http://127.0.0.1:3425/v1 \
DS_AGENT_API_KEY=magpie \
DS_AGENT_API_MODEL=workbuddy/deepseek-v4.1-flash \
NODE_NO_WARNINGS=1 pnpm bench:bakeoff
```

Use your own provider values; never commit a real key. The command prints the
JSON comparison to stdout.
