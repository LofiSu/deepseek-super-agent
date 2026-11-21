# Restart recovery and unknown external outcomes

Exactly-once side effects to local specialists (`delegate_agent`) or remote channels (outbox send) are impossible after a crash: the process may die after the effect started but before completion is persisted.

## Persisted lifecycle

- `documents` kind `external_op`: phases `started` → `completed` | `failed` | `unknown_outcome` | `operator_released`.
- Outbox: `recordOutboxSendStart` on claim/send; `finishOutboxSendOperation` on success or terminal failure so a normal send is not left `started` across restart.
- Outbox rows still in `sending` at restart move to `unknown_outcome` instead of blind `pending` retry.

## On `Runtime.start()`

1. `finalizeUncertainExternalEffects` marks every `started` op and every `sending` outbox row as uncertain.
2. Live affected tickets receive a pending approval with `requestedBy: recovery` and immutable `recovery.source: crash-boundary` plus the exact persisted effect IDs. `UNKNOWN-OUTCOME:` remains display text only.
3. ADR-004 ticket recovery (`RECOVERED` prompt + replacement assignment) is **skipped** while that approval is pending.

## Operator recovery (no credentials)

1. Inspect SQLite under `DS_AGENT_HOME`: ticket `collab.approvals`, `external_op` docs, outbox `unknown_outcome` rows.
2. Verify remote/local state out of band (Feishu message, specialist workspace, etc.).
3. Approve the recovery request only if safe to retry. It releases only the effect IDs embedded in that approval, moving eligible outbox rows back to `pending` and ops to `operator_released` for an **explicit** operator-approved retry.
4. Deny if the effect already happened or must not repeat; then resume or close the ticket manually.

Ended tickets have no resumable approval. Inspect their durable effect IDs with `pnpm ds-agent recovery-effects <ticketId>`, then resolve exactly one verified ID with `pnpm ds-agent recovery-effects <ticketId> retry <effectId>` or `pnpm ds-agent recovery-effects <ticketId> acknowledge <effectId>`. `retry` is available only for an uncertain Outbox row, because it has a durable redrain path. Delegate operations have no resumable child process after Ticket end, so the CLI requires `acknowledge` after remote verification. The CLI refuses live Tickets, which must use their recovery approval.

## Feature PR publication approval outcome

A feature PR approval is durably consumed before the host publisher runs. Inspect its persisted facts with the read-only command `pnpm ds-agent publish-outcome <ticketId>` (or add `--json`). It does not call GitHub, inspect credentials, change approval state, or retry publication.

- `admitted` means the approval and immutable repository/commit/branch/PR binding were recorded, but publisher entry was not recorded. The approval remains consumed.
- `attempt_started` means the publisher boundary was recorded before entry. After a crash or a failed local confirmation write, an external push or PR effect may or may not have happened.
- `unconfirmed` means the publisher threw. The exception is not evidence that the remote effect did not happen; raw provider errors are not stored in the diagnosis record.
- `returned` records that the publisher returned normally and its PR number, branch, and repository were stored. It does not provide an independent remote reconciliation check.
- `legacy_unrecorded` is a pre-v6 consumed admission. Its original binding and publisher result were not persisted, and the current Ticket approval is not used to invent them.

The owner should inspect the recorded repository, head commit, branch, base, and PR details directly in the remote service. If the result remains uncertain, keep the consumed approval and do not retry it. After resolving the remote state, have the Worker request a fresh approval with a new approval ID; the owner makes that decision explicitly. There is no automatic replay, admission release, automatic approval, or claim of GitHub exactly-once behavior. No admission row means only that this ledger has no row; it does not backfill or rule out older publication activity.

## Boundaries

- In-process worker bash and mesh tools remain at-least-once as before.
- Specialist children do not survive parent SIGKILL; recovery never auto-restarts an in-flight delegate RPC.
