import { describe, expect, it } from 'vitest'
import { TeamRegistry } from '../src/harness/team.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

describe('T14 TeamRegistry', () => {
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
})
