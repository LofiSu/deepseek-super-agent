import type { JobRow } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

export interface TeamMemberSpec {
  name: string
  role?: string
}

export interface TeamMember {
  jobId: string
  name: string
  role: string
  status: JobRow['status']
  report?: string
}

export interface TeamRecord {
  id: string
  parentSessionId: string
  ticketId: string
  members: TeamMember[]
  createdAt: string
  completedAt?: string
}

/**
 * Worker-internal Team (PLAN T14). Router only sees the parent Assignment report;
 * member job completions stay inside the parent worker session.
 */
export class TeamRegistry {
  private readonly teams = new Map<string, TeamRecord>()
  private readonly jobToTeam = new Map<string, string>()

  constructor(private readonly store: Store) {}

  spawnTeam(input: {
    parentSessionId: string
    ticketId: string
    members: TeamMemberSpec[]
  }): TeamRecord {
    if (input.members.length === 0) throw new Error('spawnTeam needs at least one member')
    const id = `team_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const members: TeamMember[] = input.members.map(spec => {
      const job = this.store.createJob({
        sessionId: input.parentSessionId,
        ticketId: input.ticketId,
        name: `team:${spec.name}`,
      })
      this.jobToTeam.set(job.id, id)
      return {
        jobId: job.id,
        name: spec.name,
        role: spec.role ?? 'member',
        status: 'running',
      }
    })
    const team: TeamRecord = {
      id,
      parentSessionId: input.parentSessionId,
      ticketId: input.ticketId,
      members,
      createdAt: new Date().toISOString(),
    }
    this.teams.set(id, team)
    return team
  }

  listMembers(teamId: string): TeamMember[] {
    return this.teams.get(teamId)?.members.map(m => ({ ...m })) ?? []
  }

  getTeam(teamId: string): TeamRecord | undefined {
    const team = this.teams.get(teamId)
    return team ? { ...team, members: team.members.map(m => ({ ...m })) } : undefined
  }

  teamIdForJob(jobId: string): string | undefined {
    return this.jobToTeam.get(jobId)
  }

  reportFromMember(jobId: string, report: string, status: JobRow['status'] = 'succeeded'): TeamRecord | undefined {
    const teamId = this.jobToTeam.get(jobId)
    if (!teamId) return undefined
    const team = this.teams.get(teamId)
    if (!team) return undefined
    const member = team.members.find(m => m.jobId === jobId)
    if (!member) return undefined
    member.status = status
    member.report = report
    this.store.completeJob(jobId, status)
    if (team.members.every(m => m.status !== 'running')) {
      team.completedAt = new Date().toISOString()
    }
    return this.getTeam(teamId)
  }

  completeTeam(teamId: string): TeamRecord | undefined {
    const team = this.teams.get(teamId)
    if (!team) return undefined
    for (const member of team.members) {
      if (member.status === 'running') {
        member.status = 'succeeded'
        this.store.completeJob(member.jobId, 'succeeded')
      }
    }
    team.completedAt = new Date().toISOString()
    return this.getTeam(teamId)
  }

  aggregateReport(teamId: string): string {
    const team = this.teams.get(teamId)
    if (!team) return ''
    return team.members
      .map(m => `- ${m.name}(${m.role}): ${m.status}${m.report ? ` — ${m.report}` : ''}`)
      .join('\n')
  }
}
