import { afterEach, describe, expect, it } from 'vitest'
import { cliTrigger } from '../src/channels/index.ts'
import { ruleClassify, type SemanticHit } from '../src/ingress/filter.ts'
import type { Completion, Model } from '../src/harness/model.ts'
import { workerSessionId } from '../src/harness/session.ts'
import type { TeamRecord } from '../src/harness/team.ts'
import { Runtime } from '../src/runtime.ts'
import type { Ticket, Trigger } from '../src/shared/types.ts'
import { shutdown, tempHome } from './fixtures.ts'

/**
 * Deterministic harness-integrated Team path. No network: a tiny scripted
 * Model stands in for the ReAct turn so the scheduleJob -> TEAM_MEMBER_DONE ->
 * aggregate wiring runs without MockModel or a live API. The live counterpart
 * lives in team-live.test.ts.
 */
const scriptedModel: Model = {
  name: 'TeamHarnessScript',
  classify(trigger: Trigger): SemanticHit {
    return ruleClassify(trigger)
  },
  async complete(): Promise<Completion> {
    return { text: 'ok' }
  },
}

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('T14 Team harness integration', () => {
  it('spawn_team path: member jobs settle into a completed team without Router events', async () => {
    runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 5,
      watchdogIntervalMs: 60_000,
    })

    // A real trigger creates a ticket + worker session, then the worker path
    // spawns a team whose members are opaque to the Router.
    expect(runtime.ingest(cliTrigger({
      id: 'team_harness_trigger',
      text: 'please investigate the login timeout',
    }))).toBe('stored')
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]!
    const sessionId = workerSessionId(ticket.id)

    const team = runtime.teams.spawnTeam({
      parentSessionId: sessionId,
      ticketId: ticket.id,
      members: [{ name: 'research' }, { name: 'coder', role: 'implementer' }],
    })
    for (const member of team.members) {
      runtime.harness.scheduleJob({ id: member.jobId, sessionId, ticketId: ticket.id })
    }
    await runtime.jobsSettled()

    const log = runtime.log.text()
    expect(log).toContain('[team] member done')
    expect(log).toContain(`teamId=${team.id}`)

    const done = runtime.teams.getTeam(team.id)!
    expect(done.completedAt).toBeTruthy()
    expect(done.members.every(member => member.status === 'succeeded')).toBe(true)
    expect(done.members.every(member => member.report === 'member done')).toBe(true)

    const aggregate = runtime.teams.aggregateReport(team.id)
    expect(aggregate).toContain('research')
    expect(aggregate).toContain('coder')

    // Router stays blind: member completions produce no domain events.
    expect(runtime.store.listEvents().filter(event => String(event.type).includes('team'))).toHaveLength(0)

    // Team rows are persisted so an offline CLI / restart can still read them.
    const persisted = runtime.store.listDocs<TeamRecord>('team')
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.id).toBe(team.id)
    expect(persisted[0]!.completedAt).toBeTruthy()
    expect(persisted[0]!.members.every(member => member.status === 'succeeded')).toBe(true)
  })

  it('complete_team path finishes a team without waiting for member jobs', async () => {
    runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 5,
      watchdogIntervalMs: 60_000,
    })
    const sessionId = 'worker_team_complete'
    const ticketId = 't_team_complete'
    const team = runtime.teams.spawnTeam({
      parentSessionId: sessionId,
      ticketId,
      members: [{ name: 'alpha' }, { name: 'beta' }],
    })
    const done = runtime.teams.completeTeam(team.id)!
    expect(done.completedAt).toBeTruthy()
    expect(done.members.every(member => member.status === 'succeeded')).toBe(true)
    expect(runtime.store.listJobs().every(job => job.status === 'succeeded')).toBe(true)
    expect(runtime.store.listDocs<TeamRecord>('team')[0]!.completedAt).toBeTruthy()
  })
})
