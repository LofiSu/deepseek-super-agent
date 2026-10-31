import { describe, expect, it } from 'vitest'
import { TeamRegistry, type TeamRecord } from '../src/harness/team.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

describe('T14 TeamRegistry', () => {
  it('rejects duplicate member ids and blank roles without creating jobs', () => {
    const store = new Store(tempHome())
    const teams = new TeamRegistry(store)
    expect(() => teams.spawnTeam({ parentSessionId: 's', ticketId: 't', members: [{ name: 'a' }, { name: 'a' }] })).toThrow()
    expect(() => teams.spawnTeam({ parentSessionId: 's', ticketId: 't', members: [{ name: 'a', role: '  ' }] })).toThrow()
    expect(store.listJobs()).toHaveLength(0)
    store.close()
  })

  it('describes only compact topology fields', () => {
    const store = new Store(tempHome())
    const teams = new TeamRegistry(store)
    const team = teams.spawnTeam({ parentSessionId: 'secret-session', ticketId: 'secret-ticket', members: [{ name: 'research', role: 'analyst' }] })
    teams.reportFromMember(team.members[0]!.jobId, 'secret-report')
    const description = teams.describeTopology(team.id)
    expect(description).toContain('research')
    expect(description).toContain('analyst')
    expect(description).not.toMatch(/secret|jobId|session|ticket|report/)
    store.close()
  })
  it('spawns members as jobs and aggregates without Router events', () => {
    const home = tempHome()
    const store = new Store(home)
    const teams = new TeamRegistry(store)
    const team = teams.spawnTeam({
      parentSessionId: 'worker_t1',
      ticketId: 't1',
      members: [{ name: 'research' }, { name: 'coder', role: 'implementer' }],
    })
    expect(team.members).toHaveLength(2)
    expect(store.listJobs()).toHaveLength(2)
    teams.reportFromMember(team.members[0]!.jobId, 'notes ready')
    teams.reportFromMember(team.members[1]!.jobId, 'patch ready')
    const done = teams.getTeam(team.id)!
    expect(done.completedAt).toBeTruthy()
    expect(teams.aggregateReport(team.id)).toContain('research')
    expect(teams.aggregateReport(team.id)).toContain('coder')
    // No domain event for member completion in this unit path — Router stays blind
    expect(store.listEvents().filter(e => String(e.type).includes('team'))).toHaveLength(0)
    store.close()
  })

  it('persists team rows so an offline reader can list them after reopen', () => {
    const home = tempHome()
    const store = new Store(home)
    const teams = new TeamRegistry(store)
    const team = teams.spawnTeam({
      parentSessionId: 'worker_t9',
      ticketId: 't9',
      members: [{ name: 'research' }, { name: 'coder', role: 'implementer' }],
    })
    teams.reportFromMember(team.members[0]!.jobId, 'notes ready')
    store.close()

    const reopened = new Store(home)
    const rows = reopened.listDocs<TeamRecord>('team')
    expect(rows).toHaveLength(1)
    const persisted = rows[0]!
    expect(persisted.id).toBe(team.id)
    expect(persisted.ticketId).toBe('t9')
    expect(persisted.members).toHaveLength(2)
    expect(persisted.members.find(m => m.name === 'research')?.status).toBe('succeeded')
    expect(persisted.members.find(m => m.name === 'coder')?.status).toBe('running')
    expect(reopened.listJobs()).toHaveLength(2)
    reopened.close()
  })

  it('completeTeam finishes running members and persists them', () => {
    const store = new Store(tempHome())
    const teams = new TeamRegistry(store)
    const team = teams.spawnTeam({
      parentSessionId: 'worker_t10',
      ticketId: 't10',
      members: [{ name: 'a' }, { name: 'b' }],
    })
    const done = teams.completeTeam(team.id)!
    expect(done.completedAt).toBeTruthy()
    expect(done.members.every(m => m.status === 'succeeded')).toBe(true)
    expect(store.listJobs().every(job => job.status === 'succeeded')).toBe(true)
    const persisted = store.listDocs<TeamRecord>('team')[0]!
    expect(persisted.completedAt).toBeTruthy()
    store.close()
  })

  it('filters persisted teams by ticket and session', () => {
    const store = new Store(tempHome())
    const teams = new TeamRegistry(store)
    teams.spawnTeam({ parentSessionId: 'worker_a', ticketId: 'ta', members: [{ name: 'x' }] })
    teams.spawnTeam({ parentSessionId: 'worker_b', ticketId: 'tb', members: [{ name: 'y' }] })
    teams.spawnTeam({ parentSessionId: 'worker_a', ticketId: 'tb', members: [{ name: 'z' }] })
    expect(teams.listTeams()).toHaveLength(3)
    expect(teams.teamsForTicket('tb')).toHaveLength(2)
    expect(teams.teamsForSession('worker_a')).toHaveLength(2)
    store.close()
  })
})
