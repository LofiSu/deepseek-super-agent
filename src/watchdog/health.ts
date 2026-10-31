import fs from 'node:fs'
import path from 'node:path'
import type { MachineRegistry } from '../harness/machines.ts'
import type { Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'
import { stuckAssignments, stuckSessions } from './watchdog.ts'

/** Read-only snapshot; no vault values or runtime startup. */
export function healthProbe(store: Store, home: string, machines?: MachineRegistry): {
  store: string
  vaultMode: 'absent' | 'ok' | 'insecure'
  machinesOnline: number
  watchdogIdle: boolean
} {
  const vaultPath = path.join(home, 'vault.json')
  const vaultMode = fs.existsSync(vaultPath)
    ? (fs.statSync(vaultPath).mode & 0o077) === 0 ? 'ok' : 'insecure'
    : 'absent'
  const now = Date.now()
  const tickets = store.listDocs<Ticket>('ticket')
  const paused = new Set(tickets.filter(ticket => ticket.collab?.paused).map(ticket => ticket.id))
  const sessions = store.listSessions().filter(session =>
    !(session.ticketId != null && paused.has(session.ticketId)))
  return {
    store: store.health(),
    vaultMode,
    machinesOnline: machines?.list().filter(machine => machine.status === 'online').length ?? 0,
    watchdogIdle: stuckAssignments(tickets, store.listJobs(), now, 60_000).length === 0
      && stuckSessions(sessions, now, 60_000).length === 0,
  }
}
