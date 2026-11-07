# T48 month-scale LTM measurement protocol

> **Status: T48 remains `[~]` (partial).** This document defines how the
> month-scale long-term-memory claim is measured and recorded. It is a
> protocol, not a result. The offline fixture smoke below validates the
> measurement hooks; it is **not** calendar-month evidence and does not flip
> T48 to `[x]`.

## 1. Why this protocol exists

The T48 code path is on `main`: hot ticket/decision memories, cold Thread
digests, and hybrid lexical + semantic recall. The acceptance statement is
about behavior *across months* — an entry written in one calendar month must
still be recallable after hot retention has pruned it, with ACL and determinism
intact. No store whose entries were actually created across calendar months has
been measured, so the status stays `[~]`.

This document makes that measurement dated, labelled, and reproducible, and
separates two things that are easy to confuse:

- the **offline fixture smoke**, which runs in seconds with synthetic dates;
- the **operator month-spanning run**, which is required to make a T48 claim.

## 2. What is already true on `main`

| Capability | Where | Evidence |
|---|---|---|
| Scoped LTM with hot/cold tiers | `src/memory/long-term.ts` (`SpillBackedLongTermMemory`, `prune`, `archive`) | `test/long-term-memory.test.ts`, `test/memory-graph.test.ts` |
| Hot defaults 1000 entries / 90 days; cold digests 200 / 3650 days | `src/runtime.ts` `memoryRetentionFromEnv`; `src/memory/long-term.ts` | `test/long-term-memory.test.ts` retention cases |
| ADR-010 lexical recall: NFKC, case/punctuation, stop words, synonyms, tag-only, exactly one tag hop | `src/memory/long-term.ts` `query`; `docs/ARCHITECTURE_DECISIONS.md` ADR-010 | `test/memory-recall-eval.test.ts` (11/11 macro recall@3, held-out queries, negative controls) |
| Semantic arm behind a tiny `EmbeddingPort` | `src/memory/embedding.ts` (`EmbeddingPort`, `cosine`) | `test/semantic-memory.test.ts` |
| Default-on, offline, dependency-free `HashedEmbedding` (128 dimensions) | `src/memory/embedding.ts`; `src/runtime.ts` constructs it when semantic recall is enabled | #152 (commit `922b3b9`); `test/semantic-memory.test.ts` |
| Opt-out and floor | `DS_AGENT_SEMANTIC_RECALL=0` (`semanticRecallEnabled`), `DS_AGENT_EMBEDDING_FLOOR` default `0.35` (`embeddingFloorFromEnv`), `DEFAULT_EMBEDDING_FLOOR` | `test/semantic-memory.test.ts` configuration cases |
| ACL preserved on every hit | `query()` requires a reader ticket and grants the exact spill; `readSpillFor` re-checks the grant | `test/long-term-memory.test.ts`, `test/semantic-memory.test.ts` |
| Redaction before storage and before the embedding port | `SpillBackedLongTermMemory.put`/`remember`/`vectorOf` | `test/semantic-memory.test.ts` redaction case |

What is **not** true yet: there is no recorded measurement of a store whose
entries have real `createdAt` values spanning two or more calendar months.

## 3. What "month-scale" means for acceptance

A run qualifies as month-scale evidence only when all of these hold:

1. The corpus contains entries whose **real** creation dates span at least two
   calendar months (UTC), and those dates are recorded.
2. At least one entry is old enough that the configured hot retention prunes it
   (`maxAgeDays`, or count pressure), and at least one entry survives hot
   retention.
3. After pruning, the old topic is still retrievable from the cold tier
   (`query({ tier: 'cold' })`) for a labelled query.
4. The reader still receives the exact spill grant for a hit, and an unrelated
   reader is still denied.
5. Repeated queries and a reopened SQLite store return the same ids.
6. The semantic arm is measured separately from the lexical path (at least one
   query with no canonical lexical overlap, using `HashedEmbedding` or another
   `EmbeddingPort`).

Synthetic clock jumps can satisfy the mechanics but not point 1. That is why
the fixture smoke stays partial evidence.

## 4. Inputs

### 4.1 Offline fixture corpus (in the harness)

`scripts/t48-month-scale-protocol.ts` ships four redacted entries, one per
synthetic month, each on its own Thread:

| Thread | Synthetic `createdAt` (UTC) | Text |
|---|---|---|
| `billing` | 2026-01-15T12:00:00Z | `invoice csv rejected blank rows` |
| `gateway` | 2026-02-15T12:00:00Z | `gateway bearer token rotated after incident` |
| `deploy` | 2026-03-15T12:00:00Z | `deploy pipeline paused during incident review` |
| `semantic-topic` | 2026-04-15T12:00:00Z | `idempotency key rejected` |

The injected clock advances to `2026-07-15T12:00:00Z` (more than 90 days after
every corpus entry) and writes one fresh entry. That write drives
`prune()`/`archive()`, so all four corpus entries become cold Thread digests.
The `semantic-topic` query is `idempotent keys`: it shares no canonical token
with the stored body and has cosine `0.516` under `HashedEmbedding`, above the
`0.35` floor.

### 4.2 Operator month-spanning corpus (required to flip T48)

Use either a copy of a store from an instance that has been writing memories
for at least two real calendar months, or an operator-dated corpus whose
`createdAt` values are the actual creation dates from that period. Do not
rewrite real dates to manufacture a span.

Requirements:

- at least two distinct UTC calendar months between the earliest and latest
  relevant `createdAt`;
- at least one entry that the run's retention actually prunes and at least one
  that survives;
- a labelled query per topic you intend to score, plus at least one
  semantic-only query;
- redacted text only — never place credentials or model context in the
  corpus;
- a copy of the database. Recall grants and lazy embedding write-back mutate
  the store; the measurement must not run against the live database without a
  backup (`ds-agent backup`, see `docs/UPGRADE.md`).

## 5. Procedure

### 5.1 Offline fixture smoke (runnable now)

```bash
pnpm t48:smoke
```

The command is offline: no network, no live model, no wall-clock sleep. It
performs the following inside one temporary SQLite store:

1. Writes the four corpus entries at their synthetic `createdAt` values.
2. Advances the injected clock past `maxAgeDays = 90`.
3. Writes one fresh entry, which triggers retention pruning.
4. Asserts the four aged hot entries were pruned and folded into four cold
   digests (digest survival `4/4`).
5. Runs four labelled cold-tier queries at `k = 3` and computes macro recall@3.
6. Runs the semantic query against a lexical-only instance and a hybrid
   instance of the same store to isolate the semantic arm's contribution.
7. Checks that a digest spill is unreadable before recall, readable to the
   reader after recall, and unreadable to an unrelated reader.
8. Repeats the queries and reopens the store to check determinism.

Record the output in the template below if you quote it. Label it
**synthetic fixture smoke**, never "month-scale result".

### 5.1.1 Longitudinal offline harness (synthetic clock, parent-scheduled)

```bash
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 pnpm t48:long
```

This runs the fixture smoke, simulates a store reopen, checks unrelated-query
contamination (expect 0 hits), and **appends one JSONL row** to:

`$DS_AGENT_HOME/.ds-agent/measurement/t48-journal/t48-measurements.jsonl`

Override the file with `DS_AGENT_T48_JOURNAL=/absolute/path.jsonl`. The harness
uses an injected multi-month clock only — label output **synthetic**, not
calendar-month evidence. Recommended parent frequency: weekly or monthly cron
on a **copy** of the store; this repo does not create cron jobs. See
`scripts/t48-longitudinal-harness.ts` and `src/measurement/t48-journal.ts`.

### 5.2 Operator month-spanning run (required for `[x]`)

1. Record the baseline commit SHA, the run date in UTC, the machine, the Node
   version, and the retention values in use.
2. Back up the operator store and work on a copy.
3. Inventory the copy: earliest and latest `ltm` `createdAt`, the number of hot
   and cold entries, and the `embeddingId`s present. Confirm at least two real
   calendar months of span.
4. Define the labelled query manifest (query id, text, relevant Thread) before
   looking at results. Include a semantic-only query.
5. Apply the retention window and observation date that correspond to the run
   date. If the store has not yet pruned naturally, run the same prune path
   and state exactly how it was triggered.
6. Run the metric definitions in §6 against the copy. The fixture harness's
   `measure`/`verifyReopen` functions are the reference implementation of the
   same checks; record the exact command or temporary driver used.
7. Record the environment, results, per-query ranks, limitations, and
   reproduction steps using §7. Commit the completed record as a separate
   document (for example `docs/T48_MONTH_SCALE_RESULTS.md`) and have the owner
   review it.

Until step 7 exists on `main`, T48 stays `[~]`.

## 6. Metrics

| Metric | Definition | Expected |
|---|---|---|
| `hotEntriesPruned` | Corpus entries absent from the hot tier after prune | > 0, and every aged entry |
| `digestSurvival` | Archived Threads with a readable cold digest / archived Threads | `1.0` |
| `coldRecallAt3` | Mean fraction of each query's labelled relevant Threads present in the top 3 cold results | Report the measured value; `1.0` for the fixture |
| `aclEnforcedBeforeRecall` | A digest spill throws for the reader before any recall grant | `true` |
| `aclGrantedAfterRecall` | The same spill is readable by the querying ticket after recall | `true` |
| `aclStillEnforcedForOtherReaders` | An unrelated ticket is still denied after recall | `true` |
| `semanticLexicalHits` | Hits for the semantic-only query with no embedding port | `0` |
| `semanticHybridHits` | Hits for the same query with the port | Greater than lexical hits |
| `semanticArmContribution` | `semanticHybridHits - semanticLexicalHits` | > 0 |
| `deterministicWithinSession` | Repeated queries return identical ids | `true` |
| `deterministicAfterReopen` | A reopened store returns the same ids | `true` |

Also report `semanticHybridHits` precision informally: a high contribution
with many off-topic hits is a quality signal, not a pass.

## 7. Result record template

Copy this block into a dated result document. Replace every `<...>`. Do not
pre-fill values you did not measure.

````markdown
# T48 month-scale LTM measurement — <YYYY-MM-DD>

> <Synthetic fixture smoke | Operator month-spanning run>. <One line on what
> this does and does not prove.>

## Environment

| Field | Value |
|---|---|
| Baseline | `main` = `<sha>` |
| Run date (UTC) | `<YYYY-MM-DDTHH:MMZ>` |
| Machine | `<OS>, Node <version>` |
| Embedding port | `<hashed-v1:128 | other id>` |
| Embedding floor | `<0.35>` |
| Retention | hot `<entries>`/`<days>`; cold `<entries>`/`<days>` |
| Corpus span | `<first createdAt>` → `<last createdAt>` (`<real | synthetic>` dates) |
| Entries (hot/cold) | `<n>` / `<n>` |
| Command | `<exact command>` |

## Results

| Metric | Value |
|---|---:|
| Hot entries pruned | `<n>` |
| Digest survival | `<n/n>` |
| Cold recall@3 | `<0.000>` |
| ACL before / after recall | `<true | false>` |
| Semantic lexical / hybrid hits | `<n>` / `<n>` |
| Deterministic (session / reopen) | `<true | false>` |

## Per-query ranks

| Query id | Query text | Relevant Thread | Ranked Threads (top 3) | Recall@3 |
|---|---|---|---:|---:|
| `<id>` | `<text>` | `<thread>` | `<a, b, c>` | `<0 | 1>` |

## Interpretation

- `<What the numbers show, in one or two sentences.>`
- `<Whether the run qualifies as month-scale evidence under §3.>`

## Limitations

- `<Synthetic dates? fixture size? single machine? no live channel?>`
- `<Was the store copied? Was retention triggered naturally or replayed?>`
- `<Any embedding provider difference or backfill caveat.>`

## Reproduce

```bash
<exact commands, including how the store copy and labelled manifest were made>
```

## Appendix — raw JSON

```json
<harness output>
```
````

## 8. Completion rule

T48 flips from `[~]` to `[x]` only when a dated operator run satisfying §3 is
recorded, reviewed, and merged. The offline fixture smoke — including a green
`pnpm t48:smoke` and its JSON — is a regression check for the measurement
hooks, not month-scale evidence.

## Appendix A — recorded offline fixture smoke (synthetic)

This run validates the harness only. Dates are synthetic and `createdAt` was
produced by the injected clock, so it is **not** completion evidence.

| Field | Value |
|---|---|
| Baseline | `main` = `48d0479` + this branch's harness |
| Run date (UTC) | 2026-11-06 |
| Machine | Linux x64, Node v24.22.1 |
| Command | `pnpm t48:smoke` |
| Synthetic months | 2026-01-15, 2026-02-15, 2026-03-15, 2026-04-15 |
| Observation date | 2026-07-15T12:00:00.000Z |
| Embedding | `hashed-v1:128`, floor `0.35` |
| Retention | hot 1000/90; cold 200/3650 |

| Metric | Value |
|---|---:|
| Hot entries pruned | 4 |
| Cold digests | 4 (survival 4/4) |
| Cold recall@3 | 1.0 |
| Semantic lexical / hybrid hits | 0 / 1 |
| ACL (before / other reader) | `true` / `true` |
| Deterministic (session / reopen) | `true` / `true` |
