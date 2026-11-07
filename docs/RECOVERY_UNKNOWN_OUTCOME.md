# Restart recovery and unknown external outcomes

Exactly-once side effects to local specialists (`delegate_agent`) or remote channels (outbox send) are impossible after a crash: the process may die after the effect started but before completion is persisted.

## Persisted lifecycle

- `documents` kind `external_op`: phases `started` → `completed` | `failed` | `unknown_outcome` | `operator_released`.
- Outbox rows mid-send move to `unknown_outcome` instead of blind `pending` retry.

## On `Runtime.start()`

1. `finalizeUncertainExternalEffects` marks every `started` op and every `sending` outbox row as uncertain.
2. Affected tickets receive a pending approval whose action begins with `UNKNOWN-OUTCOME:`.
3. ADR-004 ticket recovery (`RECOVERED` prompt + replacement assignment) is **skipped** while that approval is pending.

## Operator recovery (no credentials)

1. Inspect SQLite under `DS_AGENT_HOME`: ticket `collab.approvals`, `external_op` docs, outbox `unknown_outcome` rows.
2. Verify remote/local state out of band (Feishu message, specialist workspace, etc.).
3. Approve the `UNKNOWN-OUTCOME` request only if safe to retry; approval runs `releaseUnknownOutcomeEffects` (outbox → `pending`, ops → `operator_released`).
4. Deny if the effect already happened or must not repeat; then resume or close the ticket manually.

## Boundaries

- In-process worker bash and mesh tools remain at-least-once as before.
- Specialist children do not survive parent SIGKILL; recovery never auto-restarts an in-flight delegate RPC.
