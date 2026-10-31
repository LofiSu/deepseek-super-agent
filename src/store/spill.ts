import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SpillBody, SpillRecord } from '../shared/types.js'
import type { SpillStore } from '../shared/ports.js'

export class SqliteSpill implements SpillStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  put(body: SpillBody, summary?: string): string {
    const stored = encode(body)
    const id = randomUUID()
    const record: SpillRecord = {
      id,
      summary: summary ?? stored.summary,
      createdAt: this.now(),
      encoding: stored.encoding,
      body: stored.body,
    }
    this.db.prepare(
      'INSERT INTO spills (id, summary, encoding, body, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(record.id, record.summary, record.encoding, record.body, record.createdAt)
    return id
  }

  get(id: string): SpillRecord | undefined {
    const row = this.db.prepare(
      'SELECT id, summary, encoding, body, created_at FROM spills WHERE id = ?',
    ).get(id) as SpillRow | undefined
    return row ? fromRow(row) : undefined
  }

  readObject(id: string): unknown {
    const record = this.get(id)
    if (!record) return undefined
    if (record.encoding === 'json') return JSON.parse(record.body) as unknown
    if (record.encoding === 'bytes') return Buffer.from(record.body, 'base64')
    return record.body
  }
}

interface SpillRow {
  id: string
  summary: string
  encoding: SpillRecord['encoding']
  body: string
  created_at: string
}

function fromRow(row: SpillRow): SpillRecord {
  return {
    id: row.id,
    summary: row.summary,
    encoding: row.encoding,
    body: row.body,
    createdAt: row.created_at,
  }
}

function encode(body: SpillBody): { encoding: SpillRecord['encoding']; body: string; summary: string } {
  if (typeof body === 'string') {
    return { encoding: 'text', body, summary: body.slice(0, 160) }
  }
  if (body instanceof Uint8Array) {
    const encoded = Buffer.from(body).toString('base64')
    return { encoding: 'bytes', body: encoded, summary: `bytes:${body.byteLength}` }
  }
  const json = JSON.stringify(body)
  return { encoding: 'json', body: json, summary: json.slice(0, 160) }
}

export function toInline(summary: string, spillIds: string[]): { summary: string; spillIds: string[] } {
  return { summary, spillIds }
}
