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

## Boundaries

- In-process worker bash and mesh tools remain at-least-once as before.
- Specialist children do not survive parent SIGKILL; recovery never auto-restarts an in-flight delegate RPC.
