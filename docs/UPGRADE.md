# Upgrade and rollback

This runbook covers an existing SQLite state directory (`DS_AGENT_HOME`, or
`./.ds-agent` by default). The database is a single file, `ds-agent.db`, plus
SQLite's transient `-wal` and `-shm` sidecars while the process is running.

The store migrates itself when it opens. There is no separate migrate command.
Migrations are versioned and transactional, and this build never rewrites an
applied step.

## Supported versions

| State | Schema version | This build (0.1.x, `LATEST_SCHEMA_VERSION=3`) |
|---|---|---|
| Fresh or current | 3 | Opens with no migration. |
| Version 1 (original tables) | 1 | Migrates 1 -> 2 -> 3 in one transaction. |
| Version 2 (outbox columns) | 2 | Migrates 2 -> 3 in one transaction. |
| Legacy file with no `schema_migrations` ledger | 0 | Runs every migration with `CREATE TABLE IF NOT EXISTS`; existing rows are kept. |
| Any file recorded above 3 | > 3 | **Refused before any write.** Upgrade the binary first. |

Node.js 22 or newer is required (`node:sqlite`). A newer Node is fine. A
different SQLite build is not relevant: the migration ledger, not the SQLite
library version, is what this build checks.

## What happens when the store opens

`new Store(home)`:

1. Creates `home` if needed and opens `home/ds-agent.db`.
2. Calls `migrate()`:
   - reads `MAX(version)` from `schema_migrations` when the ledger exists;
   - refuses a version above `LATEST_SCHEMA_VERSION` before taking a write
     lock;
   - otherwise runs `BEGIN IMMEDIATE`, re-reads the ledger, applies pending
     steps in order, and records each step in the same transaction.
3. Only after a successful migration sets `PRAGMA journal_mode=WAL`.

The steps are additive:

| Version | Change |
|---|---|
| 1 | Original tables: `documents`, `spills`, `spill_grants`, `jobs`, `sessions`, `messages`, `replies`, `outbox`, `subscriptions`, `artifacts`, `events`, `id_seq`. |
| 2 | Adds `outbox.idempotency_key`, `outbox.attempts`, and `outbox.next_attempt_at` if missing. |
| 3 | Adds `lifecycle_events` for restart replay. |

A crash or a failed step rolls the whole migration transaction back, so the
database stays at its previous recorded version. Re-running the same binary is
safe: applied steps are skipped.

The **fail-closed future-version rule** is intentional. A database written by
a newer build is not downgraded in place, and `restore` also refuses a backup
whose recorded version is above this build's maximum. The error names the
found and supported versions. Upgrade the binary, or restore an older backup,
rather than editing `schema_migrations` by hand.

## Back up before upgrading

Stop the ds-agent process first. A backup can snapshot a live WAL database,
but the upgrade procedure is easier to verify and roll back with a stopped
process.

Once the CLI integration lands, the command is:

```bash
ds-agent backup --out "$HOME/ds-agent-backup-$(date +%Y%m%dT%H%M%SZ).db"
```

In this branch the command bodies and standalone entry ship before the
`src/cli/main.ts` dispatch, so the equivalent is:

```bash
npx tsx src/cli/backup.ts \
  --home "${DS_AGENT_HOME:-./.ds-agent}" \
  --out "$HOME/ds-agent-backup-$(date +%Y%m%dT%H%M%SZ).db"
```

`backupStore` / `runBackupCommand` behavior:

- Takes a consistent `VACUUM INTO` snapshot, including committed WAL frames
  that have not been checkpointed.
- Refuses an output path that already exists.
- Refuses the live database, its `-wal`/`-shm` sidecars, and reserved spill
  directories (`<home>/spills`, `<home>/spill`).
- Requires a `.db` or `.sqlite` extension unless explicitly allowed.
- Makes the output mode `0600` and fsyncs it before reporting success.

Verify the snapshot before relying on it:

```bash
sqlite3 "$HOME/ds-agent-backup-YYYYMMDDTHHMMSSZ.db" \
  'PRAGMA integrity_check; SELECT MAX(version) FROM schema_migrations;'
```

## Upgrade procedure

1. Stop every ds-agent process using the state directory. Check for a running
   `serve`, `gateway`, or channel loop.
2. Back up as above and verify `integrity_check` returns `ok`.
3. Install or build the new binary (`git checkout <release>`, `pnpm install
   --frozen-lockfile`, `pnpm build`, or install the release tarball).
4. Start one short-lived command that opens the store, such as `ds-agent
   status` or `ds-agent health`. This applies pending migrations.
5. Confirm the schema version and data:

   ```bash
   sqlite3 "${DS_AGENT_HOME:-./.ds-agent}/ds-agent.db" \
     'SELECT MAX(version) FROM schema_migrations;'
   ```

6. Run `ds-agent health` and a normal command before restarting the daemon.
7. Keep the pre-upgrade backup until the new version has served traffic.

## Restore

Restore is an offline, replace-in-place operation. **Stop the target process.**
The restore path probes for an active write lock and fails with a clear message
when one is held, but an idle process can hold no lock at the instant checked;
the probe is not a substitute for stopping it.

```bash
# Once wired:
ds-agent restore --input "$HOME/ds-agent-backup-YYYYMMDDTHHMMSSZ.db"

# In this branch:
npx tsx src/cli/backup.ts \
  --home "${DS_AGENT_HOME:-./.ds-agent}" \
  --input "$HOME/ds-agent-backup-YYYYMMDDTHHMMSSZ.db"
```

`restoreStore` / `runRestoreCommand` behavior:

- Opens the backup read-only and reads its schema version. A file with no
  `schema_migrations` table is treated as legacy schema 0.
- Refuses a backup newer than this build's `LATEST_SCHEMA_VERSION`.
- Copies to a temporary file in the state home, fsyncs it, removes the
  replaced database's stale `-wal`/`-shm` files, and renames the temporary
  file over `ds-agent.db`.
- Does not migrate the restored file. The next `Store` open does that.
  Restoring a legacy (schema 0) backup therefore prints a note, and the next
  start migrates it to 3.

Restoring a backup from the same or an older schema is the supported rollback
across a failed upgrade. Restoring a backup from a newer schema is refused; it
must be opened by a build that supports that version.

## Verification queries

Run these with the process stopped, so the WAL sidecars are quiescent:

```bash
DB="${DS_AGENT_HOME:-./.ds-agent}/ds-agent.db"

# Ledger and integrity
sqlite3 "$DB" 'PRAGMA journal_mode;'
sqlite3 "$DB" 'SELECT version, applied_at FROM schema_migrations ORDER BY version;'
sqlite3 "$DB" 'PRAGMA integrity_check;'
sqlite3 "$DB" 'PRAGMA quick_check;'

# Basic row counts (table names match schema version 3)
sqlite3 "$DB" <<'SQL'
SELECT 'documents' AS table_name, COUNT(*) AS rows FROM documents
UNION ALL SELECT 'events', COUNT(*) FROM events
UNION ALL SELECT 'lifecycle_events', COUNT(*) FROM lifecycle_events
UNION ALL SELECT 'outbox', COUNT(*) FROM outbox;
SELECT kind, COUNT(*) FROM documents GROUP BY kind;
SQL
```

Expected: `journal_mode` is `wal` for a store this build has opened;
`integrity_check` and `quick_check` return `ok`; the ledger contains `1`, `2`,
and `3`. A legacy backup may have an empty or missing ledger until its next
open.

## Rollback checklist

1. Stop the process.
2. Install the previous binary/tarball.
3. If the previous binary supports the current schema version (table above),
   start it; no restore is needed.
4. If the schema advanced past the previous binary's maximum, restore the
   pre-upgrade backup with the previous binary's `restore` path (or by
   replacing `ds-agent.db` while stopped), then remove any stale `-wal`/`-shm`
   files.
5. Verify with the queries above and `ds-agent health`.
6. Never delete or rewrite `schema_migrations` to force a downgrade.
