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

/** Compact one-line topology: member names, roles, and statuses only. */
export function describeTopologyOf(team: TeamRecord): string {
  return team.members.map(m => `${m.name} (${m.role}, ${m.status})`).join('; ')
}

/** Full aggregate report: one line per member with its optional report. */
export function aggregateReportOf(team: TeamRecord): string {
  return team.members
    .map(m => `- ${m.name}(${m.role}): ${m.status}${m.report ? ` — ${m.report}` : ''}`)
    .join('\n')
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
    const names = new Set<string>()
    for (const member of input.members) {
      if (typeof member.name !== 'string' || !member.name.trim()) throw new Error('spawnTeam member needs a name')
      if (names.has(member.name)) throw new Error(`spawnTeam duplicate member: ${member.name}`)
      names.add(member.name)
      if (member.role !== undefined && (typeof member.role !== 'string' || !member.role.trim())) {
        throw new Error(`spawnTeam member ${member.name} needs a non-empty role`)
      }
    }
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
    this.persist(team)
    return team
  }

  listMembers(teamId: string): TeamMember[] {
    return this.teams.get(teamId)?.members.map(m => ({ ...m })) ?? []
  }

  getTeam(teamId: string): TeamRecord | undefined {
    const team = this.teams.get(teamId)
    return team ? { ...team, members: team.members.map(m => ({ ...m })) } : undefined
  }

  describeTopology(teamId: string): string {
    const team = this.teams.get(teamId)
    return team ? describeTopologyOf(team) : ''
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
    this.persist(team)
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
    this.persist(team)
    return this.getTeam(teamId)
  }

  aggregateReport(teamId: string): string {
    const team = this.teams.get(teamId)
    return team ? aggregateReportOf(team) : ''
  }

  /** Every team the store has recorded, in creation order. */
  listTeams(): TeamRecord[] {
    return this.store.listDocs<TeamRecord>('team')
  }

  /** Teams spawned under one ticket, in creation order. */
  teamsForTicket(ticketId: string): TeamRecord[] {
    return this.listTeams().filter(team => team.ticketId === ticketId)
  }

  /** Teams spawned under one worker session, in creation order. */
  teamsForSession(sessionId: string): TeamRecord[] {
    return this.listTeams().filter(team => team.parentSessionId === sessionId)
  }

  /** Persist the team row so a restart (or an offline CLI) can still read it. */
  private persist(team: TeamRecord): void {
    this.store.putDoc('team', team.id, team)
  }
}
