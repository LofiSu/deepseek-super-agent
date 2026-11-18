# Execution receipts

`pnpm ds-agent receipt <ticketId>` reads the local SQLite state and prints an
execution receipt. Add `--json` for a machine-readable result. The command is
read-only at the application-data level: it opens an existing SQLite store
without creating directories, migrating the schema, checkpointing, resuming
work, retrying effects, starting a model, or sending a message. SQLite may
create transient `-wal`/`-shm` sidecars in the existing state directory while
opening a WAL database; it does not change the durable database contents. If the
store does not exist, the command fails without creating one. Use an exact
ticket id or a unique prefix. The read-only SQLite mode requires Node.js 22.12
or newer.

```text
pnpm ds-agent receipt ticket_42
pnpm ds-agent receipt ticket_42 --json
```

The receipt reports `success`, `failed`, or `unknown` from persisted Ticket and
Assignment state. A ready terminal report is success; a failed report is
failure; unfinished, interrupted, stopped, blocked, discarded, or otherwise
inconclusive work remains unknown. It separately reports outbound delivery:
only a durable `sent` outbox row is success, a failed row is failure, and
pending/sending/unknown-outcome rows are unknown. A command that merely queued a
send is never reported as delivered.

Evidence is limited to persisted input record ids/kinds/timestamps, channel
source names, assignments/report kinds, local CLI reply status, durable outbox
status, and tracked external-operation phase. Receipt output intentionally omits
input/reply bodies, channel destinations, external ids, raw adapter errors,
operation details, and credential values. It is a local read model, not a new
outbound channel or a replay command.

A receipt is not a complete access audit. Input records show what was attached
to a Ticket, not proof that a model attended to every item. The repository does
not record arbitrary model/tool reads or all possible external effects; no
matching record means only that no evidence was persisted in the tracked
sources, not that nothing was accessed or changed. This command has only been
tested against offline SQLite fixtures; no real GitHub, Feishu, email, or other
external service was contacted for acceptance.
