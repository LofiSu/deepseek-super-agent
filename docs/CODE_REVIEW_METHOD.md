# Code review method for this repo

This maps [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/) (Addy Osmani, Morgan Westlee Lunt, Qing Wang, 15 Oct 2026) onto `ds-agent`. The article describes a monorepo-scale pipeline: machine review before a person looks, risk-based human approval, a merge queue, flags, and rollback. This repository is a single TypeScript package with no CI workflows, no `CODEOWNERS`, no feature flags, and no incident dashboard. The mapping below keeps the article's decisions and drops the machinery this repo does not have.

The behavior contract people reach for is [`PLAN.md`](../PLAN.md). It has drifted from `src/`. [`ARCHITECTURE_REVIEW.zh.md`](./ARCHITECTURE_REVIEW.zh.md) is the current explainer of that drift (4 high, 10 medium, 5 low). A review that treats PLAN or a README checkbox as proof of behavior repeats the failure that review already records.

## What review is for

The article splits review into two jobs: catch problems before they ship, and spread a working picture of the system. "Did a human read every line?" is the wrong proxy. The question is what can go wrong with this change, and which check — a test, a demo assertion, or a person — is the one that can see it.

Human attention is the scarce resource. Cutting review time by skipping the check just moves the cost into breakage. The article tracks human approvals, human comments, and how long a PR waits on a person, with revert and incident rates as the guardrail. This repo has none of those dashboards. Until it does, the practical guardrail is: the PR body names the commands that ran and what they printed, and a later revert of a demo or test failure is treated as a signal to tighten the tier, not as blame.

## Life of a change

### 1. Verify before anyone else looks

The article's rule is to give the authoring agent something it can run, and to show the output. Boris Cherny's note in the article is that verification is domain-specific: a command, a test suite, or a running UI. Here the commands are:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm demo
```

There is no `.github/` workflow. A green local run is not a hosted check. The PR body still has to say which of these ran and the result. `pnpm demo` defaults to `MockModel`. A live `DS_AGENT_API_*` run uses `LIVE_DEMO_PROOFS` and skips the scripted Mock needles (`spill`, `deliver=true`, watchdog session text, and others). Say which mode ran.

Demo proofs are substring checks on log lines (`src/cli/demo.ts`). `Evals.batch` is logged for a batch of one. `[watchdog] tick` is logged on an idle timer. `deliver=true` is logged because the mock worker's second report sets that flag. A review of batching, watchdog action, or the speculative discard path has to point at a branch in `src/` or a new assertion. A passing demo is not that evidence.

The article also asks for a fresh-context pass over the diff before the PR exists: one pass for bugs, one to simplify, one for the behavior. Style comments that the article's filters would drop — formatting, naming taste, wording nits — stay off the PR.

Repeated review comments belong in a short reviewer note, not in a longer PLAN. This file is that note. The article's `CLAUDE.md` / `REVIEW.md` advice applies directly:

- Say what failure looks like here. For docs and PLAN, failure is a claim of behavior the code does not perform. For config and routing, failure is a trigger admitted, batched, or delivered by the wrong path. For env and tools, failure is a credential value or an unbounded command result reaching the model.
- Cap nits. Do not block on comment wording or mermaid styling.
- Skip generated lockfile noise unless the dependency set changed.
- Every finding names a file and the behavior. A guess from a function name is not a finding.
- The summary starts with a count and says plainly when there is nothing to fix.

### 2. Review the diff against intent

The article's PR reviewer reads the diff against the stated intent and asks whether the change does that, fits the system, and breaks something else. On a bug fix it looks for the root cause.

Intent in this repo is the PR description plus the task id in PLAN (T01–T44) when the change claims one. The reviewer checks `src/` and `test/`. README checkboxes and the audit table at the bottom of PLAN are not evidence. Findings already written up in `docs/ARCHITECTURE_REVIEW.zh.md` are pre-existing: tag them that way so a docs-only or unrelated PR is not asked to grow a new engine.

Severity uses the same three words as the architecture review:

| Tier | What it means here | Examples |
|------|--------------------|----------|
| 高 | A control action or safety boundary the change relies on does not run, or the change opens one | Eval always accepting; watchdog tick that only logs; speculative tickets staying visible and undiscarded; tool output or prompts carrying credential values; a new writer of tickets outside `Engine` |
| 中 | The skeleton is real and the control flow, model split, or contract text will mislead the next change | Batching, `roleModels`, rule-based slow path, spill without locality, `started` not ending the turn, ack sent from `Tickets.create`, subscription predicates, `meta.admitted`, PLAN/README status lines |
| 低 | Names, layout, templates, and items PLAN already marks as Phase-2 | Node engine line, `ds-agent.db`, email formatting, missing event names, T09 and T45–T50 left undone |

Drop findings that are only style, diagnostics, or drive-by cleanup. The article's tags map as: Important → 高 or 中 that this PR introduced; Nit → do not post; Pre-existing → already listed in the architecture review, or present on the base branch and untouched by the diff.

Each posted 高 or 中 finding has to be fixed or the thread closed with a reason. A later commit that fixes it can clear it. An agent may write the fix. The person who directed the change still answers for it.

### 3. Security bar that blocks

The article gives security its own blocking pass. This repo's blocking bar is the one PLAN already states and does not enforce (architecture review H4):

- `DS_AGENT_API_KEY` and other secret values stay out of system prompts, tool results, the session journal, spill bodies, and demo logs.
- A check that only confirms the key is sent as an `Authorization` header is not enough. `bash` stdout is copied into the journal today.
- Worker sessions do not gain `reply_user`. Domain ticket/decision writes stay inside `Engine` transactions.
- `Trigger.meta` is caller-controlled. `meta.admitted === true` currently skips the engine filter. A change that lets an external payload set that flag is 高.

There is no separate security bot. The reviewer applies this list on any PR that touches `src/env/`, `src/harness/model.ts`, `src/harness/tools.ts`, `src/harness/session.ts`, `src/runtime.ts`, or `src/core/`. An unresolved 高 item on that list blocks merge. Closing the thread needs a one-line reason, including when the finding is pre-existing and the PR does not make it worse.

### 4. Automated checks

The article's CI layer is lint, types, tests, and a build, plus a PR note for how it was tested and how to undo it. The authoring agent can draft that note. The person who asked for the change signs it.

This repo currently has no hosted CI. Do not describe a PR as machine-gated. The note to include is:

- **Testing.** Commands and the outcome. Include a failure case when the change touches filtering, fan-out, spill, speculative delivery, jobs, or watchdog behavior. Name the assertion, not only a log substring.
- **Risk.** One of 高 / 中 / 低, chosen from the diff, not from who wrote it.
- **How to revert.** The revert command or the runtime switch. There is no flag system. `git revert` of the merge is the rollback. Say so when that is the whole plan.

`pnpm typecheck` and `pnpm test` are the checks a reviewer can re-run. `pnpm demo` is the end-to-end script. Add a behavioral test when a demo needle would stay green if the feature were hollow.

### 5. Human approval, scaled by risk

The article's tiers: low changes can merge on automated checks for trusted authors; medium needs one person; high needs two; some paths always need a person; a bot approval never fills a human slot; an approval covers one commit. The directing person counts as a reviewer on an agent-written change.

Apply that with this repo's actual staffing. There is no trusted-author list and no branch protection in the tree. Starting strict:

| Risk | Paths and examples | Who has to sign |
|------|--------------------|-----------------|
| 低 | `docs/**` prose, README wording, comments, log text that does not change a branch | The directing person, after the testing note. A second person is not required. |
| 中 | `src/harness/**` (except the security files in 高), `src/ingress/**`, `src/memory/**`, `src/channels/**`, `src/speculate/**`, `src/cli/**`, and PLAN status lines that mark a task done | One person: the directing author counts. |
| 高 | `src/core/**`, `src/env/**`, `src/store/schema.ts`, `src/watchdog/**`, `src/harness/model.ts`, `src/runtime.ts` ingest and eval wiring, any new outbound channel, any dependency with native code or network | The directing person and one other person. Agent approval does not count as either. |

`PLAN.md` interface or "done" edits are 中 even though they are prose. Agents implement from that file. A docs PR that only records gaps, and does not mark new tasks done, stays 低.

New commits after approval need a new look. The article is specific: an agent push or a hand-resolved merge dismisses the previous approval. Follow that when more than one person is required. On a 低 docs change, the directing person re-checks the testing note if the diff changed.

Only loosen a tier after a revert or a missed bug shows the old tier was heavier than the failures. The article is explicit that the team does not yet auto-tighten approvals when incident numbers move, and that people wanted that brake before more zero-human merges. This repo should not invent zero-human merges to imitate the article's destination.

### 6. Merge, flags, gradual release

The article re-runs checks in a merge queue and ships behavior behind a flag to employees first. This package has one entry point, `pnpm demo` / `pnpm ds-agent`, and no flag helper. Do not add a queue or a flag framework as part of an unrelated change.

The substitute is small diffs, MockModel as the default so a demo does not call the network, and revert as the undo. A change that alters admission, fan-out, or delivery should land with a test that fails if the new branch is removed.

### 7. Detection and rollback

The article's last layer is fast detection: flags off without a deploy, an on-call rotation, incident review that asks which layer should have caught it. None of that staff exists here.

What does exist: the directing person watches the next `pnpm test` and `pnpm demo` on `main`. If those go red, revert first and then decide whether the missing check was a test, a demo assertion, or a review that trusted a log line. Record that as a new bullet in this file or as a test. The article's loop is the same: a miss means the reviewer lacked some input, so the fix goes into the note, the test, or the skill — not into a longer argument on the closed PR.

There is no circuit breaker. If demo or test reverts start clustering, raise the default tier for `src/core/**` rather than adding process text.

## Making the reviewer converge

The article measured noise by what people did with comments (fixed, rejected, intentional, irrelevant) and found that extra rounds mostly restated old findings. About 59% of lines an internal reviewer kept flagging were already in the first pass. One PR ran more than fifty agent review rounds overnight. Their priority is catching real bugs first and cutting rounds second. An agent author will "fix" a nit with another commit and another round, so noise is more expensive here than a person's shrug.

Rules for this repo:

- Cap at three review rounds. After that, the author stops and restates the approach. Do not open round four to rephrase a 低 comment.
- After the first substantive pass, re-review the new diff. Do not restate H1–H4 on every PR that does not touch them.
- When a mistake is a class (every `meta.*` gate, every log-needle proof), say the class once. Fixing one line and leaving the siblings is a miss.
- Do not repost a finding already on the PR or already listed as pre-existing in `docs/ARCHITECTURE_REVIEW.zh.md`.
- Do not let an agent reviewer and an agent author negotiate style. The article's noise filters exist because that loop does not converge.

There is no daily incident eval set. The seed for one is small and concrete: tests that fail when a log line is present and the behavior is absent. Candidates already named by the architecture review are batch size greater than 1, a speculative report that discards with no outbox row, a watchdog tick that fails a stuck assignment, and a journal assertion that the API key value is absent. Add one of those when changing that area. Do not build a harness that re-scores the reviewer on a schedule until those tests exist.

## Where a person stays

The article keeps people on direction, on risky code, on architecture others will copy, on reading the evidence, and on owning the outcome. Same list here:

- Whether a PLAN task should be implemented, narrowed, or marked undone. H1–H4 are direction, not nits.
- Reviewing `src/core/**`, env execution, store schema, and watchdog mutations. Those paths set patterns the rest of the code copies.
- Reading the evidence: the test name, the command, the output. If the only proof is a substring in `DEMO_PROOFS`, ask for a behavioral check or say the gap stays open.
- Owning what merges. The person who directed an agent-written change owns the revert.

A person does not have to re-read an idle log line or a checkbox in the README.

## Sharing context

The article's second job — how people learn the system when machines read most diffs — is unanswered by a formal process on their team. They ask for an explainer of the slice being changed. `docs/ARCHITECTURE_REVIEW.zh.md` is that explainer for the PLAN-to-code gap. Prefer updating it when a 高 or 中 finding closes, so the next reader does not re-derive the same table. A one-line copy fix does not need an explainer.

## You land it, you own it

The article's norm: if you merged a small or medium change and it breaks, you usually fix it. The conditions they rely on are only partly true here.

- Keep changes small enough to revert in one commit.
- Revert is the undo. Say that in the PR. Do not imply a flag that is not in the tree.
- 高 paths get a second person because the blast radius is the domain model, the credential boundary, or the control loop.
- The demo and the unit tests are the only fast signal. They miss hollow log proofs, which is why those proofs are called out above.
- A revert is about the missing check, not about who typed the diff.

## When the direction changes

The article's observation is that agents make starting cheap, so some PRs should be closed. Raise the other direction on the PR early, while the diff is small. Closing is cheap relative to reviewing a finished engine that PLAN described and the code never had. A review of a docs change should not expand into implementing H1–H4 in the same branch. File that as separate work, or mark the PLAN rows undone in a contract change that is reviewed as 中.

## PR checklist

Use this in the PR body:

```text
Testing:
- pnpm test:
- pnpm typecheck:
- pnpm demo (Mock or live):
Risk: 低 | 中 | 高
How to revert:
```

Reviewer summary shape, taken from the article's request that a summary start with a count:

```text
0 高, 0 中, 0 低. Nothing to fix.
```

or

```text
1 高, 2 中, 0 低.
- 高 src/core/evals.ts: evaluateDue still always accepts; this PR adds another caller.
- 中 ...
Pre-existing, not introduced here: H2, H3, H4.
```

## What this repo does not pretend to run

Aligned with the article's "how to adopt" list, these are absent and should stay described as absent:

- Hosted CI, merge queue, CODEOWNERS enforcement, and required-review branch protection.
- An AI reviewer that votes and posts inline comments on every PR.
- Feature flags, a stable release channel, and an on-call rotation.
- A daily eval built from incidents. The seed is the behavioral tests named above.
- Zero-human merge. 低 changes still need the directing person to sign the testing note.

When a hosted check or a second human becomes real, update this file in the same change. Until then, the review process is the testing note, the tier, the security list, and a person reading the evidence for anything 中 or 高.
