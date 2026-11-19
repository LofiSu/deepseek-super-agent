import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTERNAL_OP_KIND, type ExternalOperationRecord } from '../src/core/external-effects.ts'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-receipt-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function runReceipt(home: string, ticketId: string, json = true) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/main.ts', 'receipt', ticketId, ...(json ? ['--json'] : [])],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DS_AGENT_HOME: home,
        DS_AGENT_API_KEY: 'receipt-must-not-show-this-api-key',
        NODE_NO_WARNINGS: '1',
      },
    },
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function makeTicket(input: {
  id: string
  report?: { kind: string; text: string; at: string }
  assignmentState?: Ticket['assignments'][number]['state']
  ended?: Ticket['ended']
}): Ticket {
  const at = '2026-11-19T12:00:00.000Z'
  return {
    id: input.id,
    title: 'private-ticket-title',
    brief: 'private-ticket-brief',
    mandate: {
      strength: 'explicit',
      policyVersion: 'receipt-test',
      scope: 'private-mandate-scope',
      actor: { source: 'cli', id: 'owner' },
      basis: 'addressed',
    },
    threadKeys: ['feishu:private-thread'],
    channels: [{ source: 'im', thread: 'private-thread', address: { chat_id: 'private-destination' } }],
    inputs: [{
      id: `${input.id}_input_1`,
      kind: 'trigger',
      triggerId: 'private-trigger-id',
      text: 'private-input-body',
      at,
      human: true,
    }],
    assignments: [{
      id: `${input.id}_asg_1`,
      state: input.assignmentState ?? (input.ended ? 'ended' : 'running'),
      speculative: false,
      startedAt: at,
      ...(input.ended ? { endedAt: input.ended.at } : {}),
      ...(input.report ? { report: { ...input.report, deliver: true } } : {}),
    }],
    speculative: false,
    originTriggerId: 'private-origin-trigger',
    createdAt: at,
    ...(input.ended ? { ended: input.ended } : {}),
  }
}

function addOutbound(store: Store, ticketId: string, status: 'pending' | 'sending' | 'sent' | 'failed'): void {
  const at = '2026-11-19T12:00:00.000Z'
  const id = `${ticketId}_outbox_1`
  store.enqueueOutbox({
    id,
    replyId: `${ticketId}_reply_1`,
    ticketId,
    channel: 'im',
    thread: 'private-thread',
    target: { chat_id: 'private-destination' },
    text: 'private-outbound-body',
    status,
    idempotencyKey: 'private-idempotency-secret',
    attempts: status === 'sending' ? 1 : 0,
    createdAt: at,
  })
  if (status === 'sent') store.markOutboxSent(id, 'private-external-id')
  if (status === 'failed') store.markOutboxFailed(id, 'private-error-secret')
}

describe('ds-agent receipt', () => {
  it('queries persisted evidence after restart without exposing bodies or another ticket', () => {
    const home = tempHome()
    const store = new Store(home)
    const ticket = makeTicket({
      id: 'ticket_1',
      report: { kind: 'ready', text: 'private-report-body', at: '2026-11-19T12:01:00.000Z' },
      ended: { at: '2026-11-19T12:01:00.000Z', outcome: 'ready', by: 'executor' },
    })
    ticket.channels[0]!.source = 'private-channel-token'
    store.putDoc('ticket', ticket.id, ticket)
    store.putDoc('ticket', 'ticket_2', makeTicket({ id: 'ticket_2' }))
    store.addReply({
      id: 'ticket_2_reply_1',
      ticketId: 'ticket_2',
      channel: 'im',
      purpose: 'result',
      text: 'private-other-ticket-reply',
      status: 'sent',
      createdAt: '2026-11-19T12:01:00.000Z',
    })
    addOutbound(store, 'ticket_2', 'sent')
    addOutbound(store, ticket.id, 'sent')
    const operation: ExternalOperationRecord = {
      schemaVersion: 1,
      id: 'extop_1',
      kind: 'delegate_agent',
      ticketId: ticket.id,
      assignmentId: 'ticket_1_asg_1',
      idempotencyKey: 'private-operation-key',
      phase: 'completed',
      startedAt: '2026-11-19T12:00:00.000Z',
      updatedAt: '2026-11-19T12:01:00.000Z',
      detail: 'private-operation-detail',
    }
    store.putDoc(EXTERNAL_OP_KIND, operation.id, operation)
    store.close()

    const result = runReceipt(home, ticket.id)
    expect(result.status, result.stderr).toBe(0)
    const receipt = JSON.parse(result.stdout) as {
      ticketId: string
      status: string
      delivery: { status: string; items: Array<{ status: string; channel: string }> }
      trackedExternalEffects: Array<{ kind: string; status: string }>
      inputs: Array<{ kind: string }>
      channels: string[]
    }
    expect(receipt).toMatchObject({
      ticketId: 'ticket_1',
      status: 'success',
      delivery: { status: 'success', items: [{ channel: 'im', status: 'success' }] },
      trackedExternalEffects: [{ kind: 'delegate_agent', status: 'success' }],
      inputs: [{ kind: 'trigger' }],
      channels: ['other'],
    })
    for (const privateValue of [
      'private-ticket-title', 'private-ticket-brief', 'private-mandate-scope', 'private-thread',
      'private-destination', 'private-input-body', 'private-origin-trigger', 'private-trigger-id',
      'private-report-body', 'private-outbound-body', 'private-external-id',
      'private-idempotency-secret', 'private-operation-key', 'private-operation-detail',
      'receipt-must-not-show-this-api-key', 'ticket_2',
    ]) {
      expect(result.stdout).not.toContain(privateValue)
    }
  })

  it('reports persisted failures without exposing raw adapter errors', () => {
    const home = tempHome()
    const store = new Store(home)
    const ticket = makeTicket({
      id: 'ticket_3',
      report: { kind: 'failed', text: 'private-failure-report', at: '2026-11-19T12:01:00.000Z' },
      assignmentState: 'ended',
    })
    store.putDoc('ticket', ticket.id, ticket)
    addOutbound(store, ticket.id, 'failed')
    store.close()

    const result = runReceipt(home, ticket.id)
    expect(result.status, result.stderr).toBe(0)
    const receipt = JSON.parse(result.stdout) as {
      status: string
      assignments: Array<{ reportKind?: string }>
      delivery: { status: string }
    }
    expect(receipt).toMatchObject({ status: 'failed', assignments: [{ reportKind: 'failed' }], delivery: { status: 'failed' } })
    expect(result.stdout).not.toContain('private-error-secret')
    expect(result.stdout).not.toContain('private-failure-report')
  })

  it('keeps in-flight and interrupted sends unknown rather than calling them successful', () => {
    const home = tempHome()
    const store = new Store(home)
    const ticket = makeTicket({ id: 'ticket_4', assignmentState: 'running' })
    store.putDoc('ticket', ticket.id, ticket)
    addOutbound(store, ticket.id, 'sending')
    store.close()

    // A separate CLI process reopens the SQLite store, as it would after a restart.
    const result = runReceipt(home, ticket.id)
    expect(result.status, result.stderr).toBe(0)
    const receipt = JSON.parse(result.stdout) as {
      status: string
      delivery: { status: string; items: Array<{ status: string }> }
    }
    expect(receipt).toMatchObject({ status: 'unknown', delivery: { status: 'unknown', items: [{ status: 'unknown' }] } })
    expect(result.stdout).not.toContain('"status": "success"')
  })

  it('rejects future and malformed schema ledgers without migrating them', () => {
    const newerHome = tempHome()
    const newerStore = new Store(newerHome)
    newerStore.close()
    const newerDb = new DatabaseSync(path.join(newerHome, 'ds-agent.db'))
    newerDb.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
      .run(6, '2026-11-19T12:00:00.000Z')
    newerDb.close()

    const newer = runReceipt(newerHome, 'ticket_1')
    expect(newer.status).not.toBe(0)
    expect(newer.stderr).toContain('database schema version 6 is newer than this build supports (5)')

    const emptyHome = tempHome()
    const emptyStore = new Store(emptyHome)
    emptyStore.close()
    const emptyDb = new DatabaseSync(path.join(emptyHome, 'ds-agent.db'))
    emptyDb.exec('DELETE FROM schema_migrations')
    emptyDb.close()

    const empty = runReceipt(emptyHome, 'ticket_1')
    expect(empty.status).not.toBe(0)
    expect(empty.stderr).toContain('database schema ledger contains an invalid version')

    const malformedHome = tempHome()
    const malformedStore = new Store(malformedHome)
    malformedStore.close()
    const malformedDb = new DatabaseSync(path.join(malformedHome, 'ds-agent.db'))
    malformedDb.exec('DROP TABLE schema_migrations; CREATE TABLE schema_migrations (broken TEXT)')
    malformedDb.close()

    const malformed = runReceipt(malformedHome, 'ticket_1')
    expect(malformed.status).not.toBe(0)
    expect(malformed.stderr).toContain('no such column: version')
    expect(malformed.stderr).not.toContain('unknown ticket id')
  })

  it('does not create missing state or mutate the durable database while reading a receipt', () => {
    const parent = tempHome()
    const missingHome = path.join(parent, 'not-created')
    const missingStore = runReceipt(missingHome, 'ticket_1')
    expect(missingStore.status).not.toBe(0)
    expect(fs.existsSync(missingHome)).toBe(false)

    const home = path.join(parent, 'state')
    fs.mkdirSync(home)
    const store = new Store(home)
    const ticket = makeTicket({ id: 'ticket_6' })
    store.putDoc('ticket', ticket.id, ticket)
    store.close()

    // Leave a v4 store so an ordinary writable opener would run the v5 index migration.
    const dbPath = path.join(home, 'ds-agent.db')
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
DROP INDEX IF EXISTS replies_ticket_id_idx;
DROP INDEX IF EXISTS outbox_ticket_id_idx;
DELETE FROM schema_migrations WHERE version = 5;
`)
    legacy.close()
    const databaseBefore = fs.readFileSync(dbPath)

    const result = runReceipt(home, ticket.id)
    expect(result.status, result.stderr).toBe(0)
    // SQLite may leave transient WAL shared-memory sidecars after read-only access;
    // the database itself and its pre-migration schema must remain unchanged.
    expect(fs.readFileSync(dbPath)).toEqual(databaseBefore)
  })

  it('does not reveal data when a ticket is missing or a prefix is ambiguous', () => {
    const home = tempHome()
    const store = new Store(home)
    store.putDoc('ticket', 'ticket_alpha', makeTicket({ id: 'ticket_alpha' }))
    store.putDoc('ticket', 'ticket_alpine', makeTicket({ id: 'ticket_alpine' }))
    store.close()

    // The prefix lookup must not parse unrelated Ticket payloads.
    const raw = new DatabaseSync(path.join(home, 'ds-agent.db'))
    raw.prepare('INSERT INTO documents(kind, id, payload) VALUES(?, ?, ?)')
      .run('ticket', 'ticket_unrelated', '{invalid json')
    raw.close()

    const unique = runReceipt(home, 'ticket_alph')
    expect(unique.status, unique.stderr).toBe(0)
    expect(JSON.parse(unique.stdout).ticketId).toBe('ticket_alpha')

    const missing = runReceipt(home, 'no-such-ticket')
    expect(missing.status).not.toBe(0)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('unknown ticket id')
    expect(missing.stderr).not.toContain('private-ticket-title')

    const ambiguous = runReceipt(home, 'ticket_al')
    expect(ambiguous.status).not.toBe(0)
    expect(ambiguous.stdout).toBe('')
    expect(ambiguous.stderr).toContain('ambiguous ticket id prefix')
    expect(ambiguous.stderr).not.toContain('ticket_alpha')
    expect(ambiguous.stderr).not.toContain('ticket_alpine')
  })

  it('prints a concise human-readable receipt', () => {
    const home = tempHome()
    const store = new Store(home)
    const ticket = makeTicket({ id: 'ticket_5' })
    store.putDoc('ticket', ticket.id, ticket)
    store.close()

    const result = runReceipt(home, ticket.id, false)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('ds-agent execution receipt')
    expect(result.stdout).toContain('status: unknown')
    expect(result.stdout).toContain('ticket_5')
    expect(result.stdout).not.toContain('private-input-body')
  })
})
