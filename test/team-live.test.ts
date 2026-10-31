import { afterEach, describe, expect, it } from 'vitest'
import { requireLiveModelFromEnv } from '../src/harness/model.ts'
import { resolveLiveApi } from '../src/harness/providers.ts'
import { workerSessionId } from '../src/harness/session.ts'
import type { TeamRecord } from '../src/harness/team.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, settleWithDeadline, shutdown } from './fixtures.ts'

/**
 * Live Magpie counterpart to team-harness.test.ts. The team path itself is
 * driven deterministically (spawnTeam + scheduleJob); the real model runs the
 * TEAM_MEMBER_DONE worker turns, proving the wiring holds with a live model.
 */

function detectLive(): boolean {
  try {
    return resolveLiveApi() !== null
  } catch {
    return false
  }
}

const forceOffline = process.env.DS_AGENT_ALLOW_MOCK_FIXTURE === '1' || process.env.CI === 'true'
const hasLive = !forceOffline && detectLive()

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

function teamTicket(id: string): Ticket {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    id,
    title: 'team live',
    brief: 'spawn a team and aggregate a report',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'team live',
      actor: { source: 'cli', id: 'you' },
      basis: 'addressed',
    },
    threadKeys: ['cli:team-live'],
    channels: [],
    inputs: [],
    assignments: [{
      id: 'asg_team_live',
      state: 'running',
      speculative: false,
      startedAt: at,
      workerSessionId: workerSessionId(id),
    }],
    speculative: false,
    originTriggerId: 'team_live_trigger',
    createdAt: at,
  }
}

describe.skipIf(!hasLive)('live Magpie Team E2E', () => {
  it('refuses MockModel for the team path', () => {
    expect(requireLiveModelFromEnv().name).toBe('HttpOpenAI')
    runtime = freshRuntime({ watchdogIntervalMs: 60_000 })
    expect(runtime.model.name).toBe('HttpOpenAI')
  })

  it('live worker turns settle a spawned team without Router events', async () => {
    runtime = freshRuntime({ watchdogIntervalMs: 60_000, jobDelayMs: 120 })
    const ticketId = 'ticket_team_live'
    runtime.store.putDoc('ticket', ticketId, teamTicket(ticketId))

    const sessionId = workerSessionId(ticketId)
    const team = runtime.teams.spawnTeam({
      parentSessionId: sessionId,
      ticketId,
      members: [{ name: 'research' }, { name: 'coder', role: 'implementer' }],
    })
    for (const member of team.members) {
      runtime.harness.scheduleJob({ id: member.jobId, sessionId, ticketId })
    }
    expect(await settleWithDeadline(runtime, 60_000)).toBe('settled')

    const log = runtime.log.text()
    expect(log).toContain('[team] member done')
    expect(log).toContain(`teamId=${team.id}`)

    const done = runtime.teams.getTeam(team.id)!
    expect(done.completedAt).toBeTruthy()
    expect(done.members.every(member => member.status === 'succeeded')).toBe(true)

    const aggregate = runtime.teams.aggregateReport(team.id)
    expect(aggregate).toContain('research')
    expect(aggregate).toContain('coder')

    expect(runtime.store.listEvents().filter(event => String(event.type).includes('team'))).toHaveLength(0)

    const persisted = runtime.store.listDocs<TeamRecord>('team')
    const mine = persisted.find(row => row.id === team.id)
    expect(mine).toBeTruthy()
    expect(mine!.completedAt).toBeTruthy()
    expect(mine!.members.every(member => member.status === 'succeeded')).toBe(true)
  }, 180_000)
})
