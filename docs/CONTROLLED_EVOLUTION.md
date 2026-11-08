# Controlled self-evolution (native v1)

This is **not** unrestricted self-modifying agent code on `main`. Version 1 evolves a
**bounded JSON strategy** for speculative **DeliverGate** heuristics (`deliver-gate-v1`):
regex tunables consumed by `ConfigurableDeliverGate` only after human approval under
`<DS_AGENT_HOME>/evolution/`.

## Research references (mechanisms only; no upstream vendoring)

| Source | Verified date | License | What we borrowed | Limits |
|--------|---------------|---------|------------------|--------|
| [DGM](https://arxiv.org/abs/2505.22954) ([repo](https://github.com/jennyzzt/dgm)) | May 2025 | Apache-2.0 | Archive lineage, parent/child candidates, empirical staged eval | Frozen model; benchmark-specific; costly; evaluator loopholes |
| [SICA](https://arxiv.org/abs/2504.15228) ([repo](https://github.com/MaximeRobeyns/self_improving_coding_agent)) | Apr 2025 | MIT | Failure/archive feedback loop driving the next edit | Small task subsets; path dependency |
| [GEPA](https://arxiv.org/abs/2507.19457) ([repo](https://github.com/gepa-ai/gepa)) | Jul 2025 (v2 Feb 2026) | MIT | Train/validation/holdout separation; Pareto-style selection mindset | Reflective prompt mutation → here: deterministic regex proposals |
| [OpenEvolve](https://github.com/algorithmicsuperintelligence/openevolve) | May 2025 origin | Apache-2.0 | MAP-Elites/island archive metaphor → versioned candidate files | Benchmark metric ceilings; no vendor LLM determinism claims |
| [AdaEvolve](https://arxiv.org/abs/2602.20133) ([blog](https://skydiscover-ai.github.io/blog-adaevolve.html) / [repo](https://github.com/skydiscover-ai/skydiscover)) | Mar 12 2026 | Apache-2.0 | Modular Context/Generate/Evaluate/Select split; bounded budget | Limited numerical optimization evidence |

## Pipeline

1. **Traces** — offline fixture splits: `test/fixtures/evolution/{train,validation,holdout}.json` (LABEL: fixture only).
2. **Propose** — `TrainFailureProposer` reads baseline train errors (no paid LLM calls).
3. **Evaluate** — isolated OS child (`scripts/evolution-eval-child.mjs`) scores JSON strategy only.
4. **Gates** — malformed regex, holdout label leak, validation/holdout regression vs baseline, budget/timeout → fail closed.
5. **Archive** — `<home>/evolution/archive/<candidateId>/candidate.json` with digest + lineage.
6. **Promote** — `pnpm ds-agent evolution approve <runId> <candidateId>` binds exact artifact digest; writes `deliver-gate.strategy.json`.
7. **Consume** — wire `ConfigurableDeliverGate` explicitly (Runtime default stays `HeuristicDeliverGate`).
8. **Rollback** — `pnpm ds-agent evolution rollback` removes promoted file.

## CLI

```bash
export DS_AGENT_HOME=$(mktemp -d)
pnpm ds-agent evolution run --home "$DS_AGENT_HOME"
pnpm ds-agent evolution approve <runId> <candidateId> --home "$DS_AGENT_HOME"
pnpm ds-agent evolution rollback --home "$DS_AGENT_HOME"
```

Default dataset is a **fixture**. It does not read user memory, vault, or credentials.

## Honest scope

v1 is **strategy/config evolution**, not general self-code on the repository.
Automatic merge/deploy/commit to production is **disabled by design**.
