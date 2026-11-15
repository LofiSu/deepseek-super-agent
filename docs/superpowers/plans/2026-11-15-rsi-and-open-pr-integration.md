# RSI and Open PR Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the reviewed open PRs, add a concise README architecture diagram, and establish the staged path from proactive operation to owner-governed self-improvement.

**Architecture:** The Runtime remains the sole composition root. Proactivity creates ordinary `Trigger` records, the Engine owns all Ticket and Assignment state transitions, and every outward or source-changing operation passes through durable approval, isolated execution, review, and CI. RSI is delivered in stages, beginning with observation and feature proposals, then isolated implementation and release gates.

**Tech Stack:** Node.js 22, TypeScript, SQLite, Vitest, GitHub Actions, GitHub pull requests, Mermaid.

## Global Constraints

- Branch from current `origin/main`, never commit directly to `main`.
- One concern per PR, no secrets, and every feature has an offline regression test.
- Merge only an independently reviewed head with a green `typecheck and test` required check, resolved threads, and clean merge state.
- Use squash merges and verify `main` after each merge.
- `#172`, `#173`, and `#174` stay stacked on `#170` until the base PR is merged.

---

### Task 1: Verify Runtime Architecture Documentation

**Files:**
- Verify: `README.md`
- Verify: `README.zh-CN.md`
- Test: `pnpm lint`, `pnpm format:check`

**Interfaces:**
- Consumes: existing `Runtime`, `Engine`, `Harness`, `Store`, `Outbox`, and `Watchdog` ownership.
- Produces: a verified Mermaid flow showing `Channel -> Ingress -> Engine -> Harness`, with Store, Env, and Watchdog as supporting services.

- [x] Verify the existing English and Chinese Mermaid diagrams under their `Architecture` headings use actual module boundaries.
- [x] Verify the adjacent layer table links readers to `docs/MODULES.md` for M0–M11 details.
- [ ] Run `pnpm lint` and `pnpm format:check`.
- [ ] Amend documentation only if a later integration changes a displayed boundary.

### Task 2: Make Recovery Approvals Effect-Scoped

**Files:**
- Modify: `src/core/external-effects.ts`, `src/core/engine.ts`, `src/core/recovery-boundary.ts`, `src/shared/types.ts`, `src/store/sqlite.ts`
- Test: `test/external-effects.test.ts`, `test/restart-recovery-approval-os.test.ts`, `test/recovery-boundary.test.ts`

**Interfaces:**
- Consumes: persisted external-effect records and `Engine.decideApproval`.
- Produces: immutable recovery provenance and approval bindings to exact uncertain effect IDs.

- [ ] Write tests proving a model-authored action string cannot release recovery effects and that one approval releases only its named effect.
- [ ] Persist typed recovery approval metadata including `requestedBy: 'recovery'` and the effect IDs.
- [ ] Add an explicit operator resolution path for uncertain effects attached to ended Tickets.
- [ ] Run the focused recovery suites and `pnpm typecheck`.
- [ ] Commit the corrective update to the existing `#164` branch and request re-review.

### Task 3: Make Remote Results Atomic and Idempotent

**Files:**
- Modify: `src/runtime.ts`, `src/core/assignments.ts`, `src/store/sqlite.ts`
- Test: `test/runtime-remote-result-*.test.ts`, `test/remote-mesh-assignment-result-delivery-key.test.ts`

**Interfaces:**
- Consumes: authenticated remote result envelopes and Assignment state.
- Produces: one transaction that records the receipt and applies the report once, tied to the dispatched peer identity.

- [ ] Add a failure-injection regression that retries after the report write boundary.
- [ ] Store dispatched peer identity with the Assignment and reject a receipt from any other peer.
- [ ] Atomically record the receipt, report state, and any durable delivery intent before side effects.
- [ ] Run all remote-result tests and `pnpm typecheck`.
- [ ] Commit the corrective update to `#165` and request security re-review.

### Task 4: Isolate T48 Fixture State

**Files:**
- Modify: `scripts/t48-wall-clock-observe.ts`, `src/measurement/t48-persistent-store.ts`, `src/measurement/t48-journal.ts`
- Test: `test/t48-persistent-process.test.ts`, `test/t48-wall-clock-observe.test.ts`, `test/t48-longitudinal.test.ts`

**Interfaces:**
- Consumes: measurement home and production Runtime home.
- Produces: a dedicated measurement fixture database below the measurement directory, never the normal Runtime database.

- [ ] Write a regression with production LTM rows and confirm fixture retention cannot alter them.
- [ ] Require a dedicated fixture database path and reject a production store path.
- [ ] Make journal/state progress updates atomic or serialize one run with a lock.
- [ ] Run `pnpm t48:smoke` and the focused tests.
- [ ] Commit the corrective update to `#166` and request re-review.

### Task 5: Correct Deployment Probe Evidence

**Files:**
- Modify: `src/env/sandbox-probe.ts`, `src/cli/feishu.ts`
- Test: `test/sandbox-wrapper-probe.test.ts`, `test/channel-resident-gate.test.ts`, `test/deployment-channel-lifecycle.test.ts`

**Interfaces:**
- Consumes: wrapper process results and resident ingress outcomes.
- Produces: a confinement result only after an in-wrapper marker plus a known connectivity-denied result, with durable Feishu cursor advancement only after committed ingress or explicit discard.

- [ ] Add regressions for wrapper bootstrap failure and successful HTTP connection with non-2xx response.
- [ ] Classify unexpected ingest exceptions as retryable and leave the cursor unchanged.
- [ ] Run focused deployment and channel tests.
- [ ] Commit the corrective update to `#167` and request security re-review.

### Task 6: Bind Evolution Final Tests to One Immutable Dataset

**Files:**
- Modify: `src/evolution/dataset.ts`, `src/evolution/finalize.ts`, `src/evolution/final-test-claim-lock.ts`
- Test: `test/controlled-evolution.test.ts`, `test/evolution-*.test.ts`

**Interfaces:**
- Consumes: pre-registered dataset manifest and final-test claim.
- Produces: a verified manifest commitment and an in-memory final-test byte buffer reused for hashing and scoring.

- [ ] Add a regression that mutates the manifest or final-test file between registration and finalization.
- [ ] Reject absent or malformed final-test commitments before claiming the one-shot final test.
- [ ] Carry the verified commitment into finalization and parse the same bytes hashed.
- [ ] Run controlled-evolution tests.
- [ ] Commit the corrective update to `#168` and request re-review.

### Task 7: Deduplicate Proactive Signals by Revision

**Files:**
- Modify: `src/harness/proactive.ts`, `src/harness/daemon.ts`, `src/runtime.ts`
- Test: `test/proactive.test.ts`

**Interfaces:**
- Consumes: report and approval revisions plus persisted proactive state.
- Produces: at most one committed proactive Trigger per unchanged signal, with contact quota counting committed ingress only.

- [ ] Add tests covering an unchanged blocked report over multiple days and a revised report that becomes eligible again.
- [ ] Persist a signal fingerprint from report or approval revision with committed Trigger ID.
- [ ] Update quota only after `Runtime.ingest` accepts or deduplicates the trigger correctly.
- [ ] Run `test/proactive.test.ts`, then rebase `#170` onto `main` and request re-review.

### Task 8: Secure Browser and Credential Actions

**Files:**
- Modify: `src/env/browser-errands.ts`, `src/env/fill-vault.ts`, `src/harness/tools.ts`, `src/env/vault.ts`
- Test: `test/browser-errands.test.ts`, `test/fill-tools.test.ts`, `test/fill-vault.test.ts`, `test/vault.test.ts`

**Interfaces:**
- Consumes: owner-owned destination configuration, exact approval cards, and an isolated credential service.
- Produces: driver-enforced origin checks for each browser operation and atomic approval claims before credential filling.

- [ ] Add browser-driver conformance tests for redirect and current-origin violations on navigate, read, fill, and extract.
- [ ] Bind fill approvals to immutable target and vault-entry revision; persist `claimed` before external filling and retain an explicit unknown-outcome state.
- [ ] Require strict read isolation or a credential service that cannot be read by Workers before enabling fill tools.
- [ ] Rebase and repair `#172` and `#173` after `#170` merges, with security re-review.

### Task 9: Make Connector Wake Lossless

**Files:**
- Modify: `src/connectors/google.ts`, `src/connectors/wake.ts`, `src/connectors/types.ts`
- Test: `test/connectors-google.test.ts`, `test/connectors-wake.test.ts`

**Interfaces:**
- Consumes: Google page tokens, connector cursors, and Runtime ingress results.
- Produces: resumable pagination state and wake ledger entries committed after ingress.

- [ ] Add a backlog-over-limit test and an ingress failure/retry test.
- [ ] Persist the continuation token or high-water cursor after each page only when every event on that page has committed through idempotent ingress, so a bounded wake resumes at the first uncommitted page.
- [ ] Persist wake state after idempotent ingress success, retaining the previous page cursor for retryable failures.
- [ ] Rebase and repair `#174` after `#170` merges, then request re-review.

### Task 10: Review and Integrate PR #175

**Files:**
- Modify: the existing `#175` branch only after validating each review finding.
- Test: `test/bash-policy.test.ts`, `test/git-publish.test.ts`, `test/local-env-dev-workspace-linux.test.ts`, full CI.

**Interfaces:**
- Consumes: isolated Worker workspace and host-side publishing configuration.
- Produces: a publisher that cannot execute repository-controlled hooks/configuration, push tags/protected branches, or stage runtime credentials.

- [ ] Repair the current formatting failure.
- [ ] Validate every CodeRabbit security finding independently, including Git config, hooks, URL rewrites, follow-tags, branch parsing, ignored runtime directories, ticket lifecycle, and source repository validation.
- [ ] Run focused tests, `pnpm lint`, `pnpm typecheck`, and the full offline suite.
- [ ] Submit for independent security review and merge only after green CI.

### Task 11: Productize Owner-Governed RSI

**Files:**
- Create: `src/evolution/opportunity.ts`, `src/evolution/proposal-store.ts`, `src/cli/evolution.ts`
- Modify: `src/runtime.ts`, `src/harness/daemon.ts`, `src/harness/tools.ts`, `docs/CONTROLLED_EVOLUTION.md`, `README.md`
- Test: `test/evolution-opportunity.test.ts`, `test/evolution-proposals.test.ts`, `test/cli-evolution.test.ts`

**Interfaces:**
- Consumes: recent Ticket outcomes, structured failure events, bounded owner preferences, and evaluation data.
- Produces: durable feature proposals with evidence, risk tier, estimated impact, acceptance criteria, test plan, and explicit owner decision state.

- [ ] Define `OpportunitySignal`, `FeatureProposal`, and `ProposalDecision` types with immutable evidence references.
- [ ] Write deterministic scoring tests that reject duplicate, unsupported, or high-risk auto-execution proposals.
- [ ] Add a read-only `ds-agent evolution proposals` command and a CLI-only approve/deny decision.
- [ ] Permit approved low-risk proposals to create an isolated coding task and PR, never a direct source edit or merge.
- [ ] Add metrics and a bounded retained proposal history.
- [ ] Ship in a new PR only after Tasks 2–10 security and idempotency gates are merged.

## Integration Order

1. Land Task 1 documentation separately.
2. Land Tasks 2–6 independently as their revised PRs pass review.
3. Land Task 7, then rebase the stacked #172–#174 work.
4. Land Tasks 8–10 only with specialist review and required CI.
5. Start Task 11 from the resulting `main`.
