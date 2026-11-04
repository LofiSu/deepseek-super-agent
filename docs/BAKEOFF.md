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
Both runs acknowledged the trigger, created one ticket, and accepted one Eval.
The operator's console log also shows the acknowledgement/outbox enqueue and
the worker turn. The `BakeoffSample` itself records only model calls, tickets,
Eval accepts, wall time, and counters; delivery status is not part of that
artifact. Both samples are pre-terminal (`memory.remembered=0`), so "accepted
one Eval" does not mean the work reached a terminal state before the snapshot.

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

Use your own provider values; never commit a real key. The command re-runs the
comparison. The exact JSON from the recorded run is in the appendix below.

## Appendix — recorded comparison JSON

```json
{
  "dual": {
    "mode": "dual",
    "modelCalls": 11,
    "tickets": 1,
    "evalAccepts": 1,
    "wallMs": 38805,
    "counters": {
      "ingress.admit": 1,
      "ingress.drop": 0,
      "eval.accept": 1,
      "bypass.fanout": 0,
      "bypass.context": 0,
      "executor.fail": 0,
      "speculate.deliver": 0,
      "speculate.discard": 0,
      "watchdog.nudge": 0,
      "watchdog.fail": 0,
      "watchdog.idle": 0,
      "model.error": 0,
      "model.call": 11,
      "router.shard": 1,
      "mesh.assigned": 1,
      "mesh.queued": 0,
      "mesh.dequeued": 0,
      "mesh.queue_rejected": 0,
      "mesh.queue_drained": 0,
      "memory.remembered": 0,
      "memory.recalled": 0,
      "a2a.delivery": 0
    }
  },
  "single": {
    "mode": "single",
    "modelCalls": 10,
    "tickets": 1,
    "evalAccepts": 1,
    "wallMs": 38684,
    "counters": {
      "ingress.admit": 1,
      "ingress.drop": 0,
      "eval.accept": 1,
      "bypass.fanout": 0,
      "bypass.context": 0,
      "executor.fail": 0,
      "speculate.deliver": 0,
      "speculate.discard": 0,
      "watchdog.nudge": 0,
      "watchdog.fail": 0,
      "watchdog.idle": 0,
      "model.error": 0,
      "model.call": 10,
      "router.shard": 1,
      "mesh.assigned": 1,
      "mesh.queued": 0,
      "mesh.dequeued": 0,
      "mesh.queue_rejected": 0,
      "mesh.queue_drained": 0,
      "memory.remembered": 0,
      "memory.recalled": 0,
      "a2a.delivery": 0
    }
  },
  "extraModelCalls": 1,
  "ticketsPerCall": {
    "dual": 0.09090909090909091,
    "single": 0.1
  },
  "wallRatio": 1.003127908179092,
  "verdict": "dual paid 1 extra model call(s) for Router sequencing"
}
```
