# Controlled self-evolution (native v2)

**Not** unrestricted self-modifying agent code on `main`. v2 evolves a **bounded token-list
strategy** for speculative **DeliverGate** (`deliver-gate-v1`). Runtime compiles tokens to
**linear-time alternation regex** only; arbitrary patterns are rejected.

## Research references (mechanisms only; no upstream vendoring)

| Source | Verified date | License | What we borrowed | Limits |
|--------|---------------|---------|------------------|--------|
| [DGM](https://arxiv.org/abs/2505.22954) ([repo](https://github.com/jennyzzt/dgm)) | May 2025 | Apache-2.0 | Archive lineage, parent/child candidates, staged eval | Frozen model; costly; evaluator loopholes |
| [SICA](https://arxiv.org/abs/2504.15228) ([repo](https://github.com/MaximeRobeyns/self_improving_coding_agent)) | Apr 2025 | MIT | Failure/archive feedback → next edit | Small subsets; path dependency |
| [GEPA](https://arxiv.org/abs/2507.19457) ([repo](https://github.com/gepa-ai/gepa)) | Jul 2025 (v2 Feb 2026) | MIT | Train/validation/**final** split discipline | Here: token mutation not LLM prompts |
| [OpenEvolve](https://github.com/algorithmicsuperintelligence/openevolve) | May 2025 | Apache-2.0 | Archive + evaluator feedback | Benchmark ceilings |
| [AdaEvolve](https://arxiv.org/abs/2602.20133) ([repo](https://github.com/skydiscover-ai/skydiscover)) | Mar 12 2026 | Apache-2.0 | Generate/Evaluate/Select modules; bounded budget | Limited numerical evidence |
| [AgentPilot](https://github.com/HKUDS/AgentPilot) @ 534ccaf | 2026-03-24 (pushed 2026-11-06) | MIT | ABC eval, KL-UCB arms, discover quota, bounded policy-memory carrier, SKIP≠failure | **Simplified**: minimum-cold-arms discover (not fixed quota), deterministic rule memory, fixture dataset, no upstream code copy |

## Simplified scope vs AgentPilot

- **Lineage**: search children mutate from **baseline parent** unless a prior frozen artifact exists; not a multi-hop on-disk parent chain within one experiment session.
- **Discover**: `DISCOVER_MIN_COLD_ARMS` minimum distinct tried arms — not AgentPilot fixed quota per window.
- **Per-run novel quota**: `NEW_DIRECTION_QUOTA_PER_RUN` (default 1) forces at least one cold/novel arm attempt per evolution run (KL cold pick; policy-memory tags `policy_memory:novel_quota`).
- **Selectors** (memory is **not** shared):
  - `kl-ucb` — statistical arms only; **policy memory OFF**.
  - `policy-memory` — lesson-filtered failure arms + parent→child token deltas; **KL OFF**; after retirement skips contradicted train ids (e.g. glimmer trap → next train miss `orbit`).
  - `simplified-greedy` — round-robin arms; memory OFF (counterfactual baseline).
- **Final test claim**: OS `wx` lock file + consumed marker under trusted `DS_AGENT_HOME/evolution/` (same-local-user threat model).
- **No LLM** policy memory: `policy-memory.json` stores parent→child token deltas tied to exact train case ids.
- **Frozen model**: proposals are train-failure token additions (deterministic).
- **Tiny fixture** (`test/fixtures/evolution/`): **LABEL** — no general quality guarantee.
- **Split C (`finaltest.json`)**: loaded only at `evolution finalize` once; never in search/proposer/leak checks.

## Pipeline

1. **Search (A+B)** — train + validation via isolated child; budget ledger with reserve.
2. **Propose** — `TrainFailureProposer`; arm pick via `--selector kl-ucb` | `policy-memory` | `simplified-greedy` (`search-selector.ts`).
3. **Freeze** — `evolution freeze <candidateId>`.
4. **Final test (C)** — one-shot `evolution finalize`; sealed ledger; refuses repeat.
5. **Promote** — digest binds artifact + dataset + evaluator **source hashes** + final test ledger.
6. **Consume** — `DS_AGENT_USE_PROMOTED_DELIVER_GATE=1` → `resolveDeliverGate`.

## CLI

```bash
export DS_AGENT_HOME=$(mktemp -d)
pnpm ds-agent evolution run --home "$DS_AGENT_HOME"
pnpm ds-agent evolution freeze <candidateId> --home "$DS_AGENT_HOME"
pnpm ds-agent evolution finalize <candidateId> --home "$DS_AGENT_HOME"
pnpm ds-agent evolution approve <runId> <candidateId> --home "$DS_AGENT_HOME"
pnpm ds-agent evolution rollback --home "$DS_AGENT_HOME"
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 pnpm exec tsx scripts/evolution-rounds-demo.ts
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 pnpm exec tsx scripts/evolution-two-cli-rounds.ts   # two OS CLI processes; LABEL synth; log under /tmp/
```

Automatic merge/deploy is **disabled by design**.
