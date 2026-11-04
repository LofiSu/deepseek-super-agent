import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown, tempHome } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel, silentModel } from './scripted-model.ts'

const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
})

function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.DS_AGENT_ALLOW_MOCK_FIXTURE
  delete env.DS_AGENT_SHARDS
  delete env.DS_AGENT_ROUTER_MODEL
  delete env.DS_AGENT_WORKER_MODEL
  delete env.DS_AGENT_WATCHDOG_MODEL
  return env
}

function boot(opts: {
  home?: string
  model?: ScriptedModel
  assess?: boolean
  routerShards?: { id: string; filter?: string }[]
} = {}): Runtime {
  const runtime = freshRuntime({
    home: opts.home ?? tempHome(),
    model: opts.model ?? silentModel(),
    env: isolatedEnv(),
    jobDelayMs: 5,
    watchdogIntervalMs: 60_000,
    ...(opts.routerShards ? { routerShards: opts.routerShards } : {}),
  })
  runtimes.push(runtime)
  runtime.start({ assessPending: opts.assess !== false })
  return runtime
}

/** `kind` values from one Session's persisted journal entries. */
function journalKinds(runtime: Runtime, sessionId: string): string[] {
  return runtime.store.listMessages(sessionId).map(row => {
    try {
      return String((JSON.parse(row.body) as { kind?: unknown }).kind ?? '')
    } catch {
      return ''
    }
  })
}

/** Reports one ready result, which ends a non-speculative ticket. */
function reportingModel(): ScriptedModel {
  return new ScriptedModel(request => {
    if (request.role === 'router') return { text: 'router-ok' }
    const prompt = lastPrompt(request)
    const reported = request.messages.some(message =>
      message.role === 'tool' && message.name === 'report_to_router')
    if (!reported) {
      return {
        toolCalls: [{
          id: 'report_resident',
          name: 'report_to_router',
          args: {
            ticketId: field(prompt, 'ticketId'),
            text: 'ready: login timeout fixed',
            deliver: true,
            kind: 'ready',
          },
        }],
      }
    }
    return { text: 'worker-done' }
  })
}

describe('resident Router Session', () => {
  it('starts with Runtime.start() and resumes the same Session on a later process', async () => {
    const home = tempHome()
    const first = boot({ home, assess: false })
    const started = first.store.listSessions().find(row => row.id === 'router')
    expect(started).toMatchObject({ id: 'router', role: 'router', status: 'idle' })
    expect(first.log.text()).toContain('MainSession start session=router role=router resident=true')
    expect(journalKinds(first, 'router')).toContain('session.started')
    const createdAt = started!.createdAt
    await shutdown(first)
    runtimes.splice(runtimes.indexOf(first), 1)

    const second = boot({ home, assess: false })
    const resumed = second.store.listSessions().find(row => row.id === 'router')
    expect(resumed).toMatchObject({ id: 'router', role: 'router', status: 'idle' })
    expect(resumed!.createdAt).toBe(createdAt)
    expect(journalKinds(second, 'router')).toContain('session.resumed')
  })

  it('journals admitted triggers, decisions, and the ticket lifecycle', async () => {
    const runtime = boot({ model: reportingModel() })
    runtime.ingest(imTrigger({
      id: 'trg_resident',
      thread: 'topic/resident',
      text: '@ds-agent please fix the checkout login timeout',
    }))
    await runtime.jobsSettled()

    const history = runtime.harness.routerHistory('default', 30).join('\n')
    expect(history).toContain('event=trigger.stored triggerId=trg_resident')
    expect(history).toContain('event=decision')
    expect(history).toContain('event=ticket.created')
    expect(history).toContain('event=ticket.ended')
  })

  it('gives assessment the resident history and records the outcome', async () => {
    const seen: string[] = []
    const model = new ScriptedModel(request => {
      const assessment = request.messages.find(message =>
        message.role === 'user' && message.content.startsWith('MAIN_ASSESSMENT'))
      if (assessment) {
        seen.push(assessment.content)
        return {
          text: JSON.stringify({
            kind: 'accept',
            reason: 'resident context',
            title: 'Fix login',
            scope: 'fix the checkout login timeout',
            strength: 'inferred',
          }),
        }
      }
      return request.role === 'router' ? { text: 'router-ok' } : { text: 'worker-done' }
    })
    const runtime = boot({ model })
    runtime.ingest(imTrigger({
      id: 'trg_resident_ctx',
      thread: 'topic/ctx',
      addressed: false,
      text: 'please fix the checkout login timeout',
    }))
    runtime.flushEvals()
    await runtime.assessmentsSettled()
    await runtime.jobsSettled()

    expect(seen).toHaveLength(1)
    const context = JSON.parse(seen[0]!.replace(/^MAIN_ASSESSMENT\n/, '')) as {
      triggers: { id: string }[]
      routerSession: string[]
    }
    expect(context.triggers.map(trigger => trigger.id)).toContain('trg_resident_ctx')
    expect(context.routerSession.join('\n')).toContain('event=trigger.stored')
    expect(runtime.harness.routerHistory('default', 30).join('\n')).toContain('event=assessment')
    expect(runtime.store.listDocs('ticket').length).toBe(1)
  })

  it('replays prior model turns when observations crowd the journal tail', async () => {
    const seen: string[] = []
    const model = new ScriptedModel(request => {
      seen.push(request.messages.map(message => `${message.role}:${message.content}`).join('\n'))
      return { text: 'router-ok' }
    })
    const runtime = boot({ model, assess: false })
    await runtime.harness.routerTurn('FIRST_TURN')
    for (let index = 0; index < 205; index += 1) {
      runtime.harness.routerObserve('default', { kind: 'trigger.filtered', reason: 'noise', text: `x${index}` })
    }
    await runtime.harness.routerTurn('SECOND_TURN')

    const replay = seen.at(-1) ?? ''
    expect(replay).toContain('FIRST_TURN')
    expect(replay).toContain('SECOND_TURN')
  })

  it('gives the report turn the resident observations', async () => {
    const routerPrompts: string[] = []
    const model = new ScriptedModel(request => {
      const prompt = lastPrompt(request)
      if (request.role === 'router') {
        routerPrompts.push(prompt)
        return { text: 'router-ok' }
      }
      const reported = request.messages.some(message =>
        message.role === 'tool' && message.name === 'report_to_router')
      if (!reported) {
        return {
          toolCalls: [{
            id: 'report_history',
            name: 'report_to_router',
            args: {
              ticketId: field(prompt, 'ticketId'),
              text: 'halfway',
              deliver: false,
              kind: 'progress',
            },
          }],
        }
      }
      return { text: 'worker-done' }
    })
    const runtime = boot({ model })
    runtime.ingest(imTrigger({
      id: 'trg_report_history',
      thread: 'topic/report',
      text: '@ds-agent please fix the checkout login timeout',
    }))
    await runtime.jobsSettled()

    const report = routerPrompts.find(prompt => prompt.startsWith('REPORT'))
    expect(report).toBeTruthy()
    expect(report).toContain('observed=event=trigger.stored')
  })

  it('runs assessment on the shard that routed the triggers', async () => {
    let assessed = 0
    const model = new ScriptedModel(request => {
      const prompt = lastPrompt(request)
      if (prompt.startsWith('MAIN_ASSESSMENT')) {
        assessed += 1
        return {
          text: JSON.stringify({
            kind: 'accept',
            reason: 'shard context',
            title: 'Fix login',
            scope: 'fix the checkout login timeout',
            strength: 'inferred',
          }),
        }
      }
      return request.role === 'router' ? { text: 'router-ok' } : { text: 'worker-done' }
    })
    const runtime = boot({
      model,
      routerShards: [{ id: 'im', filter: 'source:im' }],
    })
    runtime.ingest(imTrigger({
      id: 'trg_shard_assess',
      thread: 'topic/shard',
      addressed: false,
      text: 'please fix the checkout login timeout',
    }))
    runtime.flushEvals()
    await runtime.assessmentsSettled()
    await runtime.jobsSettled()

    expect(assessed).toBe(1)
    expect(runtime.harness.routerHistory('im', 30).join('\n')).toContain('event=assessment')
    expect(runtime.harness.routerHistory('default', 30).join('\n')).not.toContain('event=assessment')
  })
})
