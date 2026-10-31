import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Engine } from '../src/core/engine.ts'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { withSessionRole } from '../src/core/session-role.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { ToolRegistry, type ToolContext } from '../src/harness/tools.ts'
import type { HarnessOptions } from '../src/harness/loop.ts'
import { ruleClassify, type SemanticHit } from '../src/ingress/filter.ts'
import type { Completion, CompletionRequest, Model } from '../src/harness/model.ts'
import type { RouterPorts, WatchdogPorts, WorkerPorts } from '../src/shared/ports.ts'
import { UserError } from '../src/shared/errors.ts'
import type { Ticket, Trigger } from '../src/shared/types.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

function acceptWorker(_ports: WorkerPorts): void {}

function engineIsNotAWorkerPort(engine: Engine): void {
  // @ts-expect-error Engine is not a worker port — reply/decide/receive must stay off this surface
  acceptWorker(engine)
}

function workerMustNotDrive(ports: WorkerPorts, trigger: Trigger): void {
  // @ts-expect-error worker ports have no reply
  ports.reply('ticket', 'no', 'result')
  // @ts-expect-error worker ports have no decide
  ports.decide('trigger', { kind: 'ignore', reason: 'no' })
  // @ts-expect-error worker ports have no receive
  ports.receive(trigger)
}

function watchdogMustNotReply(ports: WatchdogPorts): void {
  // @ts-expect-error watchdog ports have no reply
  ports.reply('ticket', 'no', 'result')
}

function routerMayReply(ports: RouterPorts): void {
  ports.reply('ticket', 'yes', 'result')
  ports.decide('trigger', { kind: 'ignore', reason: 'later' })
}

describe('role port types', () => {
  it('does not type a worker as able to reply, decide, or receive', () => {
    expect(typeof engineIsNotAWorkerPort).toBe('function')
    expect(typeof workerMustNotDrive).toBe('function')
    expect(typeof watchdogMustNotReply).toBe('function')
    expect(typeof routerMayReply).toBe('function')
    type WorkerCanReply = 'reply' extends keyof WorkerPorts ? true : false
    type WorkerCanDecide = 'decide' extends keyof WorkerPorts ? true : false
    type WorkerCanReceive = 'receive' extends keyof WorkerPorts ? true : false
    type RouterCanReply = 'reply' extends keyof RouterPorts ? true : false
    type WorkerHoldsEngine = 'engine' extends keyof Extract<ToolContext, { role: 'worker' }> ? true : false
    type HarnessHoldsEngine = 'engine' extends keyof HarnessOptions ? true : false
    const workerCanReply: WorkerCanReply = false
    const workerCanDecide: WorkerCanDecide = false
    const workerCanReceive: WorkerCanReceive = false
    const routerCanReply: RouterCanReply = true
    const workerHoldsEngine: WorkerHoldsEngine = false
    const harnessHoldsEngine: HarnessHoldsEngine = false
    expect(workerCanReply || workerCanDecide || workerCanReceive || workerHoldsEngine || harnessHoldsEngine).toBe(false)
    expect(routerCanReply).toBe(true)
  })
})

describe('worker cannot reply', () => {
  it('refuses reply, decide, and receive from worker ports and from a worker turn', async () => {
    runtime = freshRuntime()
    const trigger = imTrigger({
      id: 'trg_reply',
      thread: 'topic/reply',
      text: '@ds-agent please fix the login timeout on checkout',
    })
    expect(runtime.engine.receive(trigger)).toBe('stored')
    const [decision] = runtime.engine.evaluateDue()
    const ticketId = decision?.ticketId
    if (!ticketId) throw new Error('expected a ticket')
    const stolen = 'STOLEN_BY_WORKER'
    const { worker, router, watchdog } = bindRolePorts(runtime.engine)
    const before = runtime.store.listReplies().map(reply => reply.text)

    expect(() => (worker as unknown as RouterPorts).reply(ticketId, stolen, 'result')).toThrow(/worker cannot reply/)
    expect(() => (worker as unknown as RouterPorts).decide(trigger.id, { kind: 'ignore', reason: 'no' })).toThrow(/worker cannot decide/)
    expect(() => (worker as unknown as RouterPorts).receive(imTrigger({
      id: 'trg_sneaky',
      thread: 'topic/sneaky',
      text: '@ds-agent please sneak a trigger in',
    }))).toThrow(/worker cannot receive/)
    expect(() => (watchdog as unknown as RouterPorts).reply(ticketId, stolen, 'result')).toThrow(/watchdog cannot reply/)

    await withSessionRole('worker', async () => {
      expect(() => runtime!.engine.reply(ticketId, stolen, 'result')).toThrow(UserError)
      expect(() => runtime!.engine.reply(ticketId, stolen, 'result')).toThrow(/worker cannot reply/)
      expect(() => runtime!.engine.decide(trigger.id, { kind: 'ignore', reason: 'no' })).toThrow(/worker cannot decide/)
      expect(() => runtime!.engine.receive(imTrigger({
        id: 'trg_sneaky_turn',
        thread: 'topic/sneaky',
        text: '@ds-agent please sneak a trigger in',
      }))).toThrow(/worker cannot receive/)
      const reported = runtime!.engine.report(ticketId, { kind: 'progress', text: 'still working', deliver: false })
      expect(reported.surfaced).toBe(false)
    })

    expect(runtime.store.getDoc('trigger', 'trg_sneaky')).toBeUndefined()
    expect(runtime.store.getDoc('trigger', 'trg_sneaky_turn')).toBeUndefined()
    expect(runtime.store.listReplies().map(reply => reply.text)).toEqual(before)
    expect(runtime.store.listReplies().some(reply => reply.text.includes(stolen))).toBe(false)

    router.reply(ticketId, 'from-router', 'result')
    expect(runtime.store.listReplies().some(reply => reply.text.includes('from-router'))).toBe(true)
    expect(runtime.store.listReplies().some(reply => reply.text.includes(stolen))).toBe(false)
  })

  it('lets a nested router turn reply while the outer worker turn still cannot', async () => {
    runtime = freshRuntime()
    const trigger = imTrigger({
      id: 'trg_nest',
      thread: 'topic/nest',
      text: '@ds-agent please fix the login timeout on checkout',
    })
    runtime.engine.receive(trigger)
    const ticketId = runtime.engine.evaluateDue()[0]?.ticketId
    if (!ticketId) throw new Error('expected a ticket')
    const { router } = bindRolePorts(runtime.engine)
    await withSessionRole('worker', async () => {
      expect(() => runtime!.engine.reply(ticketId, 'outer-worker', 'result')).toThrow(/worker cannot reply/)
      expect(() => router.reply(ticketId, 'router-port-during-worker', 'result')).toThrow(/worker cannot reply/)
      await withSessionRole('router', async () => {
        runtime!.engine.reply(ticketId, 'nested-router', 'result')
      })
      expect(() => runtime!.engine.reply(ticketId, 'outer-again', 'result')).toThrow(/worker cannot reply/)
    })
    const texts = runtime.store.listReplies().map(reply => reply.text).join('\n')
    expect(texts).toContain('nested-router')
    expect(texts).not.toContain('outer-worker')
    expect(texts).not.toContain('outer-again')
    expect(texts).not.toContain('router-port-during-worker')
  })

  it('rejects reply_user from a worker and does not write that reply', async () => {
    runtime = freshRuntime()
    const trigger = imTrigger({
      id: 'trg_tool',
      thread: 'topic/tool',
      text: '@ds-agent please fix the login timeout on checkout',
    })
    runtime.engine.receive(trigger)
    const ticketId = runtime.engine.evaluateDue()[0]?.ticketId
    if (!ticketId) throw new Error('expected a ticket')
    const tools = new ToolRegistry({
      store: runtime.store,
      ports: bindRolePorts(runtime.engine),
      env: new LocalEnv(`${runtime.home}/workspaces`),
      metrics: runtime.metrics,
      redact: (text: string) => text,
      log: () => undefined,
      scheduleJob: () => undefined,
      routerTurn: async () => undefined,
    })
    const stolen = 'STOLEN_BY_WORKER'
    const before = runtime.store.listReplies().length
    await expect(tools.invoke(
      { id: 'call_steal', name: 'reply_user', args: { ticketId, text: stolen, purpose: 'result' } },
      { sessionId: 'worker_ticket', role: 'worker', ticketId },
    )).rejects.toThrow(/tool reply_user is not available to worker/)
    expect(runtime.store.listReplies()).toHaveLength(before)
    expect(runtime.store.listReplies().some(reply => reply.text.includes(stolen))).toBe(false)

    await tools.invoke(
      { id: 'call_ok', name: 'reply_user', args: { ticketId, text: 'router-tool', purpose: 'result' } },
      { sessionId: 'router', role: 'router' },
    )
    expect(runtime.store.listReplies().some(reply => reply.text.includes('router-tool'))).toBe(true)
  })

  it('drops a worker session that tries to call reply_user', async () => {
    runtime = freshRuntime({ model: new WorkerStealsReply() })
    runtime.ingest(imTrigger({
      id: 'trg_session',
      thread: 'topic/session',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.drain()
    const replies = runtime.store.listReplies().map(reply => reply.text).join('\n')
    expect(replies).not.toContain('STOLEN_BY_WORKER')
    const transcript = runtime.store.listMessages().map(message => message.body).join('\n')
    expect(transcript).toContain('tool reply_user is not available to worker')
  })

  it('still lets the router send a result after a worker report', async () => {
    runtime = freshRuntime()
    runtime.ingest(imTrigger({
      id: 'trg_happy',
      thread: 'topic/happy',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.drain()
    expect(runtime.store.listReplies().some(reply => reply.purpose === 'result')).toBe(true)
    expect(runtime.log.text()).not.toContain('worker cannot reply')
  })

  it('records a router ignore without a ticket or a reply', () => {
    runtime = freshRuntime()
    const trigger = imTrigger({
      id: 'trg_ignore',
      thread: 'topic/ignore',
      text: '@ds-agent please hold this for the router',
    })
    expect(runtime.engine.receive(trigger)).toBe('stored')
    const decision = runtime.engine.decide(trigger.id, { kind: 'ignore', reason: 'not actionable' })
    expect(decision.kind).toBe('ignore')
    expect(decision.reason).toBe('not actionable')
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    expect(runtime.engine.evaluateDue()).toEqual([])
    expect(runtime.store.listReplies()).toHaveLength(0)
  })

  it('lets the watchdog fail a ticket without sending a reply', async () => {
    runtime = freshRuntime()
    runtime.engine.receive(imTrigger({
      id: 'trg_fail',
      thread: 'topic/fail',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    const ticketId = runtime.engine.evaluateDue()[0]?.ticketId
    if (!ticketId) throw new Error('expected a ticket')
    const tools = new ToolRegistry({
      store: runtime.store,
      ports: bindRolePorts(runtime.engine),
      env: new LocalEnv(`${runtime.home}/workspaces`),
      metrics: runtime.metrics,
      redact: (text: string) => text,
      log: () => undefined,
      scheduleJob: () => undefined,
      routerTurn: async () => undefined,
    })
    const before = runtime.store.listReplies().length
    await withSessionRole('watchdog', () => tools.invoke(
      { id: 'call_fail', name: 'mark_task_failed', args: { ticketId, reason: 'stuck' } },
      { sessionId: 'watchdog', role: 'watchdog' },
    ))
    expect(runtime.store.listReplies()).toHaveLength(before)
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended?.outcome).toBe('failed')
    await expect(tools.invoke(
      { id: 'call_steal', name: 'reply_user', args: { ticketId, text: 'STOLEN_BY_WORKER', purpose: 'result' } },
      { sessionId: 'watchdog', role: 'watchdog' },
    )).rejects.toThrow(/tool reply_user is not available to watchdog/)
  })
})

class WorkerStealsReply implements Model {
  readonly name = 'WorkerStealsReply'

  classify(trigger: Trigger): SemanticHit {
    return ruleClassify(trigger)
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    if (request.role !== 'worker') return { text: 'router stays quiet' }
    const tried = request.messages.some(message => message.role === 'tool' && message.name === 'reply_user')
    if (tried) return { text: 'blocked' }
    const blob = request.messages.map(message => message.content).join('\n')
    const ticketId = /^ticketId=(.*)$/m.exec(blob)?.[1]?.trim() ?? ''
    return {
      toolCalls: [{
        id: 'call_steal',
        name: 'reply_user',
        args: { ticketId, text: 'STOLEN_BY_WORKER', purpose: 'result' },
      }],
    }
  }
}
