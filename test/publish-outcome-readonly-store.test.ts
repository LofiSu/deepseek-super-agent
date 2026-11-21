import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store/sqlite.ts'
import { MIGRATIONS, migrate } from '../src/store/schema.ts'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-publish-outcome-readonly-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function runCli(home: string, ticketId: string, json = true) {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', 'src/cli/main.ts', 'publish-outcome', ticketId, ...(json ? ['--json'] : []),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, DS_AGENT_HOME: home, NODE_NO_WARNINGS: '1' },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function v5Snapshot(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let columns: unknown[]
  let migrations: unknown[]
  let rows: unknown[]
  try {
    columns = db.prepare('PRAGMA table_info(publish_approval_admissions)').all()
    migrations = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    rows = db.prepare('SELECT * FROM publish_approval_admissions ORDER BY ticket_id, approval_id').all()
  } finally {
    db.close()
  }
  return {
    dbSha256: createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'),
    columns,
    migrations,
    rows,
  }
}

function createV5Database(home: string): string {
  fs.mkdirSync(home)
  const dbPath = path.join(home, 'ds-agent.db')
  const db = new DatabaseSync(dbPath)
  try {
    expect(migrate(db, MIGRATIONS.slice(0, 5), 5)).toBe(5)
    db.exec('PRAGMA journal_mode = WAL')
    db.prepare(`INSERT INTO publish_approval_admissions(ticket_id, approval_id, admitted_at)
                VALUES(?, ?, ?)`).run('legacy-ticket', 'legacy-approval', '2026-11-21T00:00:00.000Z')
  } finally {
    db.close()
  }
  return dbPath
}

describe('publish-outcome read-only database entry', () => {
  it('does not create state or a database when the state path is absent', () => {
    const parent = makeRoot()
    const home = path.join(parent, 'state-not-created')

    const result = runCli(home, 'ticket-without-state')

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).admissions).toEqual([])
    expect(fs.existsSync(home)).toBe(false)
    expect(fs.existsSync(path.join(home, 'ds-agent.db'))).toBe(false)
  })

  it('discloses missing historical evidence when an existing state directory has no database', () => {
    const home = path.join(makeRoot(), 'existing-state')
    fs.mkdirSync(home)

    const result = runCli(home, 'ticket-without-db')

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).admissions).toEqual([])
    expect(JSON.parse(result.stdout).guidance.historicalEvidenceNote).toMatch(/cannot be determined/)
    expect(fs.readdirSync(home)).toEqual([])
  })

  it('discloses unavailable history for a pre-admission schema without migrating it', () => {
    const home = path.join(makeRoot(), 'pre-admission-state')
    fs.mkdirSync(home)
    const dbPath = path.join(home, 'ds-agent.db')
    const db = new DatabaseSync(dbPath)
    try {
      expect(migrate(db, MIGRATIONS.slice(0, 4), 4)).toBe(4)
    } finally {
      db.close()
    }
    const before = createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')

    const result = runCli(home, 'ticket-before-admissions')

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).admissions).toEqual([])
    expect(JSON.parse(result.stdout).guidance.historicalEvidenceNote).toMatch(/ledger is unavailable/)
    expect(createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')).toBe(before)
  })

  it('rejects an unsupported future schema before treating a missing ledger as unavailable history', () => {
    for (const withLedger of [false, true]) {
      const home = path.join(makeRoot(), withLedger ? 'future-with-ledger' : 'future-without-ledger')
      fs.mkdirSync(home)
      const dbPath = path.join(home, 'ds-agent.db')
      if (withLedger) {
        const store = new Store(home)
        store.close()
        const db = new DatabaseSync(dbPath)
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
          .run(7, 'owned future-schema fixture')
        db.close()
      } else {
        const db = new DatabaseSync(dbPath)
        db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations VALUES(7, 'owned future-schema fixture')`)
        db.close()
      }
      const before = createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')

      for (const json of [true, false]) {
        const result = runCli(home, 'future-ticket', json)
        expect(result.status, `${withLedger ? 'with' : 'without'} ledger, ${json ? 'JSON' : 'human'}: ${result.stdout}${result.stderr}`)
          .not.toBe(0)
        expect(`${result.stdout}${result.stderr}`).toMatch(/schema.*newer|unsupported/i)
        expect(result.stdout).not.toContain('historical publication activity cannot be determined')
      }

      expect(createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')).toBe(before)
    }
  })

  it('reports corrupt or invalid database paths without replacing them or falling back to Store', () => {
    const corruptHome = path.join(makeRoot(), 'corrupt-state')
    fs.mkdirSync(corruptHome)
    const corruptPath = path.join(corruptHome, 'ds-agent.db')
    fs.writeFileSync(corruptPath, 'owned corrupt sqlite fixture')
    const corruptBefore = createHash('sha256').update(fs.readFileSync(corruptPath)).digest('hex')

    const corrupt = runCli(corruptHome, 'ticket-corrupt')

    expect(corrupt.status).not.toBe(0)
    expect(createHash('sha256').update(fs.readFileSync(corruptPath)).digest('hex')).toBe(corruptBefore)
    expect(fs.readdirSync(corruptHome)).toEqual(['ds-agent.db'])

    const invalidHome = path.join(makeRoot(), 'invalid-state')
    fs.mkdirSync(invalidHome)
    fs.mkdirSync(path.join(invalidHome, 'ds-agent.db'))
    const invalid = runCli(invalidHome, 'ticket-invalid')
    expect(invalid.status).not.toBe(0)
    expect(fs.statSync(path.join(invalidHome, 'ds-agent.db')).isDirectory()).toBe(true)
  })

  it('reads a v5 database whose main file is marked read-only without changing it', () => {
    const home = path.join(makeRoot(), 'readonly-state')
    const dbPath = createV5Database(home)
    fs.chmodSync(dbPath, 0o444)
    const before = v5Snapshot(dbPath)

    const result = runCli(home, 'legacy-ticket')

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).admissions[0].observationState).toBe('legacy_unrecorded')
    expect(v5Snapshot(dbPath)).toEqual(before)
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o444)
  })

  it('reads committed uncheckpointed WAL state while a writer connection remains open', () => {
    const home = path.join(makeRoot(), 'wal-state')
    const store = new Store(home)
    store.close()
    const dbPath = path.join(home, 'ds-agent.db')
    const writer = new DatabaseSync(dbPath)
    try {
      writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; BEGIN IMMEDIATE')
      writer.prepare(`INSERT INTO publish_approval_admissions(
        ticket_id, approval_id, admitted_at, binding_json, observation_state
      ) VALUES(?, ?, ?, ?, ?)`).run(
        'wal-ticket', 'wal-approval', '2026-11-21T00:00:00.000Z',
        JSON.stringify({ repo: 'owner/repo', head: 'a'.repeat(40), branch: 'peanut/wal', base: 'main', title: 'WAL fixture' }),
        'admitted',
      )
      writer.exec('COMMIT')
      const walPath = `${dbPath}-wal`
      expect(fs.existsSync(walPath)).toBe(true)
      const walSize = fs.statSync(walPath).size
      const beforeRows = writer.prepare('SELECT * FROM publish_approval_admissions').all()
      const beforeSha = createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')

      const result = runCli(home, 'wal-ticket')

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).admissions).toEqual([expect.objectContaining({
        approvalId: 'wal-approval',
        observationState: 'admitted',
        binding: expect.objectContaining({ repo: 'owner/repo', branch: 'peanut/wal' }),
      })])
      expect(writer.prepare('SELECT * FROM publish_approval_admissions').all()).toEqual(beforeRows)
      expect(createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')).toBe(beforeSha)
      expect(fs.statSync(walPath).size).toBe(walSize)
    } finally {
      writer.close()
    }
  })

  it('keeps v6 JSON and human output compatible for a returned publisher result', () => {
    const home = path.join(makeRoot(), 'v6-state')
    const store = new Store(home)
    try {
      expect(store.admitPublishApprovalOnce({
        ticketId: 'returned-ticket',
        approvalId: 'returned-approval',
        binding: {
          repo: 'owner/repo', head: 'b'.repeat(40), branch: 'peanut/returned', base: 'main', title: 'Approved title',
        },
      })).toBe(true)
      store.markPublishAttemptStarted('returned-ticket', 'returned-approval')
      store.recordPublishReturned('returned-ticket', 'returned-approval', {
        number: 703, branch: 'peanut/returned', remote: 'owner/repo',
      })
    } finally {
      store.close()
    }

    const json = runCli(home, 'returned-ticket')
    const human = runCli(home, 'returned-ticket', false)

    expect(json.status, json.stderr).toBe(0)
    expect(JSON.parse(json.stdout).admissions).toEqual([expect.objectContaining({
      approvalId: 'returned-approval',
      observationState: 'returned',
      binding: expect.objectContaining({ repo: 'owner/repo', branch: 'peanut/returned' }),
      result: { number: 703, branch: 'peanut/returned', remote: 'owner/repo' },
    })])
    expect(JSON.parse(json.stdout).guidance).toMatchObject({
      remoteInspectionPerformed: false, retryPerformed: false, approvalChanged: false,
    })
    expect(JSON.parse(json.stdout).guidance).not.toHaveProperty('historicalEvidenceNote')
    expect(human.status, human.stderr).toBe(0)
    expect(human.stdout).toContain('state=returned')
    expect(human.stdout).toContain('publisher returned PR #703')
    expect(human.stdout).toContain('repo=owner/repo')
  })

  it('labels an unsupported observation state without inferring an outcome or changing consumed evidence', () => {
    const home = path.join(makeRoot(), 'unsupported-observation')
    const store = new Store(home)
    expect(store.admitPublishApprovalOnce({
      ticketId: 'unsupported-ticket',
      approvalId: 'unsupported-approval',
      binding: {
        repo: 'owner/repo', head: 'c'.repeat(40), branch: 'peanut/unsupported', base: 'main', title: 'Owned unsupported fixture',
      },
    })).toBe(true)
    store.close()

    const dbPath = path.join(home, 'ds-agent.db')
    const writer = new DatabaseSync(dbPath)
    writer.prepare(`UPDATE publish_approval_admissions SET observation_state = ?
                    WHERE ticket_id = ? AND approval_id = ?`)
      .run('returend_private_sentinel', 'unsupported-ticket', 'unsupported-approval')
    writer.close()
    const before = createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')

    const json = runCli(home, 'unsupported-ticket')
    const human = runCli(home, 'unsupported-ticket', false)

    expect(json.status, json.stderr).toBe(0)
    const diagnosis = JSON.parse(json.stdout) as { admissions: Array<Record<string, unknown>> }
    expect(diagnosis.admissions).toEqual([expect.objectContaining({
      approvalId: 'unsupported-approval', observationState: 'unsupported',
    })])
    expect(json.stdout).not.toContain('returend_private_sentinel')
    expect(json.stdout).not.toContain('result')
    expect(human.status, human.stderr).toBe(0)
    expect(human.stdout).toContain('state=unsupported')
    expect(human.stdout).toMatch(/unsupported.*outcome|outcome.*unsupported/i)
    expect(human.stdout).not.toContain('returend_private_sentinel')
    expect(human.stdout).not.toContain('publisher result is unconfirmed')
    expect(human.stdout).not.toContain('publisher returned PR')
    expect(createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')).toBe(before)

    const reopened = new Store(home)
    try {
      expect(reopened.admitPublishApprovalOnce({
        ticketId: 'unsupported-ticket',
        approvalId: 'unsupported-approval',
        binding: {
          repo: 'owner/repo', head: 'c'.repeat(40), branch: 'peanut/unsupported', base: 'main', title: 'Owned unsupported fixture',
        },
      })).toBe(false)
      expect(reopened.listPublishAdmissions('unsupported-ticket')[0]?.observationState).toBe('unsupported')
    } finally {
      reopened.close()
    }
  })

  it('projects a consumed v5 row without changing its schema, migration ledger, row, or database bytes', () => {
    const home = path.join(makeRoot(), 'state')
    const dbPath = createV5Database(home)
    const before = v5Snapshot(dbPath)

    const result = runCli(home, 'legacy-ticket')

    const after = v5Snapshot(dbPath)
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).admissions).toEqual([expect.objectContaining({
      ticketId: 'legacy-ticket',
      approvalId: 'legacy-approval',
      observationState: 'legacy_unrecorded',
    })])
    expect(JSON.parse(result.stdout).admissions[0]).not.toHaveProperty('binding')
    expect(JSON.parse(result.stdout).admissions[0]).not.toHaveProperty('result')
    expect(after).toEqual(before)
    expect(before.migrations).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }])
    expect((before.columns as { name: string }[]).map(column => column.name)).toEqual([
      'ticket_id', 'approval_id', 'admitted_at',
    ])
    expect(before.rows).toEqual([{
      ticket_id: 'legacy-ticket',
      approval_id: 'legacy-approval',
      admitted_at: '2026-11-21T00:00:00.000Z',
    }])
  })
})
