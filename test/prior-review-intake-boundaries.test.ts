import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Runtime } from '../src/runtime.ts'
import { threadKey, type Thread, type Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { ScriptedModel, silentModel } from './scripted-model.ts'

const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
})

function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.DS_AGENT_ALLOW_MOCK_FIXTURE
  delete env.DS_AGENT_ROUTER_MODEL
  delete env.DS_AGENT_WORKER_MODEL
  delete env.DS_AGENT_WATCHDOG_MODEL
  return env
}

function start(opts: { model?: ScriptedModel; env?: NodeJS.ProcessEnv; singleSession?: boolean } = {}): Runtime {
  const runtime = freshRuntime({
    model: opts.model ?? silentModel(),
    env: opts.env ?? isolatedEnv(),
    singleSession: opts.singleSession,
    jobDelayMs: 5,
    watchdogIntervalMs: 60_000,
  })
  runtimes.push(runtime)
  return runtime
}

/** Create a ticket with an explicit shard list, without starting the Harness. */
function shardedTicket(
  runtime: Runtime,
  id: string,
  shards: string[],
  thread = 'topic/guard',
): { triggerId: string; ticketId: string } {
  runtime.engine.receive(imTrigger({
    id,
    thread,
    text: '@ds-agent please fix the login timeout on checkout',
  }), { shards })
  const decision = runtime.engine.evaluateDue()[0]
  if (!decision?.ticketId) throw new Error('expected a ticket')
  return { triggerId: id, ticketId: decision.ticketId }
}

describe('independent durable Intake recovery',()=>{
 it('does not use replacement subscriptions for a legacy trigger-only row with no original plan',()=>{
  const runtime=start()
  const legacy=imTrigger({id:'legacy-no-plan',thread:'unknown/original',text:'follow-up'});
  runtime.store.putDoc('trigger',legacy.id,legacy)
  const {ticketId}=shardedTicket(runtime,'replacement-seed',['default'],'unknown/original')
  expect(runtime.store.getDoc('intake_route_plan',legacy.id)).toBeUndefined()
  const result=runtime.ingest(legacy)
  expect({result,delivered:runtime.store.getDoc<Ticket>('ticket',ticketId)?.inputs.some(i=>i.triggerId===legacy.id),hasDisposition:Boolean(runtime.store.getDoc('disposition',legacy.id))}).toEqual({result:'incomplete',delivered:false,hasDisposition:false})
 })
 it('restores a persisted original plan after real Store close/reopen without rerouting to new subscription',async()=>{
  let runtime=start();const home=runtime.home
  const {ticketId}=shardedTicket(runtime,'original-seed',['default'],'persist/plan')
  const follow=imTrigger({id:'persisted-follow',thread:'persist/plan',text:'follow-up'})
  expect(runtime.engine.receive(follow)).toBe('stored')
  const plan=runtime.store.getDoc<{fanout:string[]}>('intake_route_plan',follow.id)
  expect(plan?.fanout).toContain(ticketId)
  runtime.store.deleteDoc('disposition',follow.id)
  const original=runtime.store.getDoc<Ticket>('ticket',ticketId)!;original.inputs=original.inputs.filter(i=>i.triggerId!==follow.id);runtime.store.putDoc('ticket',ticketId,original)
  await shutdown(runtime)
  runtime=freshRuntime({home,model:silentModel(),env:isolatedEnv()});runtimes.push(runtime)
  const key=threadKey(follow.threads[0]!);const thread=runtime.store.getDoc<Thread>('thread',key)!;thread.subscriptions=[];runtime.store.putDoc('thread',key,thread)
  expect(runtime.engine.receive(follow)).toBe('stored')
  expect(runtime.store.getDoc<Ticket>('ticket',ticketId)?.inputs.filter(i=>i.triggerId===follow.id)).toHaveLength(1)
  expect(runtime.engine.receive(follow)).toBe('duplicate')
 })
})
