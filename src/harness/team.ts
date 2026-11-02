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

/** A single spawn call can create this many jobs; reject larger model-supplied lists. */
export const MAX_TEAM_MEMBERS = 8

const MAX_LABEL_LENGTH = 80
/** Names and roles are persisted and printed; reject newlines and terminal escapes. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

function labelOf(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`spawnTeam ${what} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`spawnTeam ${what} must not be blank`)
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new Error(`spawnTeam ${what} is too long (max ${MAX_LABEL_LENGTH})`)
  }
  if (CONTROL_CHARS.test(trimmed)) throw new Error(`spawnTeam ${what} contains control characters`)
  return trimmed
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
    if (!Array.isArray(input.members) || input.members.length === 0) {
      throw new Error('spawnTeam needs at least one member')
    }
    if (input.members.length > MAX_TEAM_MEMBERS) {
      throw new Error(`spawnTeam supports at most ${MAX_TEAM_MEMBERS} members`)
    }
    const specs: { name: string; role: string }[] = []
    const names = new Set<string>()
    for (const raw of input.members as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('spawnTeam member must be an object with a name')
      }
      const spec = raw as TeamMemberSpec
      const name = labelOf(spec.name, 'member name')
      if (names.has(name)) throw new Error(`spawnTeam duplicate member: ${name}`)
      names.add(name)
      const role = spec.role === undefined ? 'member' : labelOf(spec.role, `role for ${name}`)
      specs.push({ name, role })
    }
    const id = `team_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const members: TeamMember[] = specs.map(spec => {
      const job = this.store.createJob({
        sessionId: input.parentSessionId,
        ticketId: input.ticketId,
        name: `team:${spec.name}`,
      })
      this.jobToTeam.set(job.id, id)
      return {
        jobId: job.id,
        name: spec.name,
        role: spec.role,
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
    return this.cached(teamId)?.members.map(m => ({ ...m })) ?? []
  }

  getTeam(teamId: string): TeamRecord | undefined {
    const team = this.cached(teamId)
    return team ? { ...team, members: team.members.map(m => ({ ...m })) } : undefined
  }

  describeTopology(teamId: string): string {
    const team = this.cached(teamId)
    return team ? describeTopologyOf(team) : ''
  }

  teamIdForJob(jobId: string): string | undefined {
    const known = this.jobToTeam.get(jobId)
    if (known) return known
    // A fresh process has no mapping yet; recover it from the persisted team rows.
    for (const row of this.store.listDocs<TeamRecord>('team')) {
      if (row.members?.some(member => member.jobId === jobId)) {
        this.hydrate(row)
        return row.id
      }
    }
    return undefined
  }

  reportFromMember(jobId: string, report: string, status: JobRow['status'] = 'succeeded'): TeamRecord | undefined {
    const teamId = this.teamIdForJob(jobId)
    if (!teamId) return undefined
    const team = this.cached(teamId)
    if (!team) return undefined
    // complete_team already settled this team; a late timer must not rewrite it.
    if (team.completedAt) return this.getTeam(teamId)
    const member = team.members.find(m => m.jobId === jobId)
    if (!member) return undefined
    member.status = status
    member.report = report
    this.store.completeJob(jobId, status)
    if (!team.completedAt && team.members.every(m => m.status !== 'running')) {
      team.completedAt = new Date().toISOString()
    }
    this.persist(team)
    return this.getTeam(teamId)
  }

  completeTeam(teamId: string): TeamRecord | undefined {
    const team = this.cached(teamId)
    if (!team) return undefined
    for (const member of team.members) {
      if (member.status === 'running') {
        member.status = 'succeeded'
        this.store.completeJob(member.jobId, 'succeeded')
        this.jobToTeam.delete(member.jobId)
      }
    }
    // Idempotent: retrying complete_team must not move the recorded finish time.
    if (!team.completedAt) team.completedAt = new Date().toISOString()
    this.persist(team)
    return this.getTeam(teamId)
  }

  aggregateReport(teamId: string): string {
    const team = this.cached(teamId)
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

  /** Index a persisted row into the in-memory maps on first use after a restart. */
  private hydrate(team: TeamRecord): TeamRecord {
    this.teams.set(team.id, team)
    for (const member of team.members) this.jobToTeam.set(member.jobId, team.id)
    return team
  }

  private cached(teamId: string): TeamRecord | undefined {
    const inMemory = this.teams.get(teamId)
    if (inMemory) return inMemory
    const stored = this.store.getDoc<TeamRecord>('team', teamId)
    return stored ? this.hydrate(stored) : undefined
  }

  /** Persist the team row so a restart (or an offline CLI) can still read it. */
  private persist(team: TeamRecord): void {
    this.store.putDoc('team', team.id, team)
  }
}
