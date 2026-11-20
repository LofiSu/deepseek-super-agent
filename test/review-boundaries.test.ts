import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeProactiveConfig } from '../src/harness/proactive.ts'
import { FeishuClient } from '../src/channels/feishu.ts'
import {
  ConnectorWakeScheduler,
  connectorTrigger,
  loadConnectorWakeState,
  type ConnectorPendingWake,
} from '../src/connectors/wake.ts'
import { normalizeConnectorConfig } from '../src/connectors/config.ts'
import { ConnectorIndex } from '../src/connectors/index-store.ts'
import { HttpGoogleWorkspaceApi, type GoogleWorkspaceApi } from '../src/connectors/google.ts'
import type { ConnectorDraft } from '../src/connectors/types.ts'
import type { Disposition, Trigger } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []
const stores: Store[] = []

/** 2026-11-05 10:00 UTC, outside the default Shanghai quiet window. */
const T0 = Date.parse('2026-11-05T10:00:00.000Z')
const MIN = 60_000

function setup(): { home: string; store: Store; index: ConnectorIndex } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-connectors-wake-'))
  homes.push(home)
  const store = new Store(home)
  stores.push(store)
  return {
    home,
    store,
    index: new ConnectorIndex(store, { redact: text => text, now: () => new Date(T0) }),
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) if (store.isOpen) store.close()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function seedOwnerThread(store: Store): void {
  const at = new Date(T0 - 60 * MIN).toISOString()
  const trigger: Trigger = {
    id: 'trg_cli_seed',
    source: 'cli',
    threads: [{ source: 'cli', id: 'local' }],
    actor: { source: 'cli', id: 'you' },
    human: true,
    addressed: 'direct',
    at,
    text: 'hello',
    channel: { source: 'cli', thread: 'local' },
    meta: {},
  }
  store.putDoc('trigger', trigger.id, trigger)
  const disposition: Disposition = { at, fanout: [], context: [] }
  store.putDoc('disposition', trigger.id, disposition)
}

function draft(overrides: Partial<ConnectorDraft> = {}): ConnectorDraft {
  return {
    service: 'gmail',
    kind: 'message',
    externalId: 'message-1',
    title: 'Invoice for November',
    text: 'from=billing@example.com The invoice is attached',
    occurredAt: new Date(T0 - 5 * MIN).toISOString(),
    updatedAt: new Date(T0 - 5 * MIN).toISOString(),
    wake: true,
    wakeReason: 'unread important mail',
    ...overrides,
  }
}

function pendingWake(index: ConnectorIndex, at: number, suffix: string): ConnectorPendingWake {
  const record = index.upsert([draft({ externalId: `pending-${suffix}` })]).records[0]!
  const trigger = connectorTrigger(record, {
    channel: { source: 'cli', thread: 'local' },
    actor: { source: 'cli', id: 'you' },
  }, at)
  return { at, trigger, recordId: record.id, service: record.service }
}

function scheduler(input: {
  store: Store
  index: ConnectorIndex
  api: GoogleWorkspaceApi
  config?: Record<string, unknown>
  admission?: { actors?: string[]; dropSelf?: string[]; groups?: string[] }
  quiet?: { quietStart: string; quietEnd: string; timezone: string }
  now?: () => number
  env?: NodeJS.ProcessEnv
}): { runner: ConnectorWakeScheduler; fired: Trigger[]; lines: string[] } {
  const fired: Trigger[] = []
  const lines: string[] = []
  const overrides = input.config ?? {}
  const google = (overrides.google ?? {}) as Record<string, unknown>
  const poll = (overrides.poll ?? {}) as Record<string, unknown>
  const wake = (overrides.wake ?? {}) as Record<string, unknown>
  const config = normalizeConnectorConfig({
    enabled: true,
    google: { services: ['gmail', 'calendar', 'docs'], ...google },
    poll: { intervalMinutes: 15, ...poll },
    wake: {
      enabled: true,
      services: ['gmail', 'calendar', 'docs'],
      source: 'cli',
      thread: 'local',
      minIntervalMinutes: 15,
      maxPerDay: 3,
      ...wake,
    },
  })
  const runner = new ConnectorWakeScheduler({
    now: input.now ?? (() => T0),
    store: input.store,
    config,
    index: input.index,
    api: input.api,
    proactive: normalizeProactiveConfig({
      quietStart: '23:00',
      quietEnd: '08:00',
      timezone: 'UTC',
      ...(input.quiet ?? {}),
    }),
    ...(input.admission ? { admission: input.admission } : {}),
    ...(input.env ? { env: input.env } : {}),
    fire: trigger => {
      fired.push(trigger)
      input.store.putDoc('trigger', trigger.id, trigger)
      input.store.putDoc('disposition', trigger.id, {
        at: trigger.at,
        fanout: [],
        context: [],
      } satisfies Disposition)
    },
    log: line => { lines.push(line) },
  })
  return { runner, fired, lines }
}

function fakeApi(records: readonly ConnectorDraft[], failures: readonly string[] = []): GoogleWorkspaceApi {
  return {
    async fetch(service) {
      if (failures.includes(service)) throw new Error(`provider ${service} unavailable`)
      return records.filter(record => record.service === service)
    },
  }
}


describe('independent boundary probes',()=>{
  it('does not let a durably incomplete non-Calendar pending item permanently block later useful wakes',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const pending=pendingWake(index,T0,'irreparable-legacy')
    store.putDoc('trigger',pending.trigger.id,pending.trigger)
    store.putDoc('intake_recovery',pending.trigger.id,{triggerId:pending.trigger.id,reason:'legacy-routing-plan-unavailable'})
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{gmail:new Date(T0).toISOString()},pending:[pending],wakes:[],notified:[]})
    const candidate=draft({externalId:'later-useful-record',occurredAt:new Date(T0+16*MIN).toISOString(),updatedAt:new Date(T0+17*MIN).toISOString()})
    const {runner}=scheduler({store,index,api:fakeApi([candidate]),config:{google:{services:['gmail']},wake:{services:['gmail']}}})
    const attempts:string[]=[]
    ;(runner as unknown as {opts:{fire:(trigger:Trigger)=>void}}).opts.fire=trigger=>{attempts.push(trigger.id);/* real Runtime incomplete path leaves disposition absent */}
    await runner.poll(T0+16*MIN);await runner.poll(T0+32*MIN)
    expect(index.query({limit:20}).some(row=>row.externalId==='later-useful-record')).toBe(true)
    expect(loadConnectorWakeState(store).cursors?.gmail).toBe(new Date(T0+32*MIN).toISOString())
    expect(attempts.some(id=>id!==pending.trigger.id)).toBe(true)
  })

  it('retains an isolated wake across Store restart and resumes its original id once repaired',async()=>{
    const {home,store,index}=setup();seedOwnerThread(store)
    const original=pendingWake(index,T0,'recoverable-legacy')
    store.putDoc('trigger',original.trigger.id,original.trigger)
    store.putDoc('intake_recovery',original.trigger.id,{triggerId:original.trigger.id,reason:'legacy-routing-plan-unavailable'})
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{gmail:new Date(T0).toISOString()},pending:[original],wakes:[],notified:[]})
    const initial=scheduler({store,index,api:fakeApi([]),config:{google:{services:['gmail']},wake:{services:['gmail']}}})
    await initial.runner.poll(T0+16*MIN)
    expect(loadConnectorWakeState(store).incomplete).toMatchObject([{reason:'legacy-routing-plan-unavailable',pending:{trigger:{id:original.trigger.id}}}])
    expect(loadConnectorWakeState(store).wakes).toHaveLength(0)
    store.close()

    const restartedStore=new Store(home);stores.push(restartedStore)
    const restartedIndex=new ConnectorIndex(restartedStore,{redact:text=>text,now:()=>new Date(T0)})
    restartedStore.deleteDoc('intake_recovery',original.trigger.id)
    const retried:Trigger[]=[]
    const resumed=scheduler({store:restartedStore,index:restartedIndex,api:fakeApi([]),now:()=>T0+32*MIN,config:{google:{services:['gmail']},wake:{services:['gmail']} }})
    ;(resumed.runner as unknown as {opts:{fire:(trigger:Trigger)=>void}}).opts.fire=trigger=>{
      retried.push(trigger)
      restartedStore.putDoc('trigger',trigger.id,trigger)
      restartedStore.putDoc('disposition',trigger.id,{at:new Date(T0+32*MIN).toISOString(),fanout:[],context:[]} satisfies Disposition)
    }
    await resumed.runner.poll(T0+32*MIN)
    await resumed.runner.poll(T0+48*MIN)
    expect(retried).toHaveLength(1)
    expect(retried[0]).toEqual(original.trigger)
    expect(loadConnectorWakeState(restartedStore).incomplete).toBeUndefined()
    expect(loadConnectorWakeState(restartedStore).pending).toBeUndefined()
    expect(loadConnectorWakeState(restartedStore).wakes?.map(row=>row.triggerId)).toEqual([original.trigger.id])
  })
  it('expires calendar pending once provider imminent eligibility has ended (start +15min)',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const freshApi=new HttpGoogleWorkspaceApi({accessToken:async()=> 'synthetic',invalidate:()=>undefined},{now:()=>T0+30*MIN,apiBase:'https://example.test',fetch:async()=>new Response(JSON.stringify({items:[{id:'boundary-event',summary:'event',start:{dateTime:new Date(T0).toISOString()}}]}))})
    const fresh=await freshApi.fetchPage('calendar',{since:new Date(T0).toISOString(),until:new Date(T0+30*MIN).toISOString(),limit:25,lookaheadMinutes:120})
    expect(fresh.drafts[0]?.wake).toBe(false)
    const record=index.upsert([draft({service:'calendar',kind:'event',externalId:'boundary-event',occurredAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})]).records[0]!
    const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0-5*MIN)
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},pending:[{at:T0-5*MIN,trigger,recordId:record.id,service:'calendar',eligibilityDeadline:T0+120*MIN}],wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api:fakeApi([]),config:{google:{services:['calendar']},wake:{services:['calendar'],calendarLookaheadMinutes:120}}})
    await runner.poll(T0+30*MIN)
    expect(fired).toHaveLength(0)
    expect(loadConnectorWakeState(store).wakes).toHaveLength(0)
    expect(loadConnectorWakeState(store).uncertain?.[0]?.pending.trigger.id).toBe(trigger.id)
    expect(loadConnectorWakeState(store).notified).toHaveLength(0)
  })
  it('uses the provider 15-minute Calendar grace for new pending rows at the exact boundary',async()=>{
    for (const offset of [15 * MIN, 15 * MIN + 1]) {
      const {store,index}=setup();seedOwnerThread(store)
      const nowAt=T0+offset
      const provider=new HttpGoogleWorkspaceApi({accessToken:async()=> 'synthetic',invalidate:()=>undefined},{now:()=>nowAt,apiBase:'https://example.test',fetch:async()=>new Response(JSON.stringify({items:[{id:`new-${offset}`,summary:'event',start:{dateTime:new Date(T0).toISOString()}}]}))})
      const page=await provider.fetchPage('calendar',{since:new Date(T0-60*MIN).toISOString(),until:new Date(nowAt).toISOString(),limit:25,lookaheadMinutes:120})
      const shouldWake=offset===15*MIN
      expect(page.drafts[0]?.wake).toBe(shouldWake)
      const record=index.upsert([draft({service:'calendar',kind:'event',externalId:`new-${offset}`,occurredAt:new Date(T0).toISOString(),wake:shouldWake,wakeReason:shouldWake?'calendar event starting soon':undefined})]).records[0]!
      const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},nowAt)
      store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},...(shouldWake?{pending:[{at:T0,trigger,recordId:record.id,service:'calendar' as const,calendarProvenance:{version:1 as const,occurredAt:record.occurredAt,updatedAt:record.updatedAt,kind:'event' as const,wakeReason:record.wakeReason}}]}:{}),wakes:[],notified:[]})
      const {runner,fired}=scheduler({store,index,api:fakeApi([]),now:()=>nowAt,config:{google:{services:['calendar']},wake:{services:['calendar'],calendarLookaheadMinutes:120}}})
      await runner.poll(nowAt)
      expect(fired.some(item=>item.id===trigger.id)).toBe(shouldWake)
      expect(loadConnectorWakeState(store).wakes).toHaveLength(shouldWake?1:0)
    }
  })
  it('persists the provider cutoff on a newly selected Calendar pending wake',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const startsAt=T0
    let providerNow=T0
    const api=new HttpGoogleWorkspaceApi({accessToken:async()=> 'synthetic',invalidate:()=>undefined},{now:()=>providerNow,apiBase:'https://example.test',fetch:async()=>new Response(JSON.stringify({items:[{id:'newly-selected-event',summary:'event',start:{dateTime:new Date(startsAt).toISOString()}}]}))})
    store.putDoc('connector_wake','state',{lastCheckAt:T0-16*MIN,cursors:{calendar:new Date(T0-16*MIN).toISOString()},wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api,now:()=>providerNow,config:{google:{services:['calendar']},wake:{services:['calendar'],calendarLookaheadMinutes:120}}})
    ;(runner as unknown as {opts:{fire:(trigger:Trigger)=>void}}).opts.fire=trigger=>{fired.push(trigger);throw new Error('transient ingress failure')}
    await runner.poll(T0)
    expect(loadConnectorWakeState(store).pending?.[0]?.calendarProvenance).toEqual({version:1,occurredAt:new Date(startsAt).toISOString(),updatedAt:new Date(startsAt).toISOString(),kind:'event',wakeReason:'calendar event starting soon'})
    providerNow=T0+15*MIN
    await runner.poll(providerNow)
    expect(fired).toHaveLength(2)
    providerNow=T0+30*MIN
    await runner.poll(providerNow)
    expect(fired).toHaveLength(2)
    expect(loadConnectorWakeState(store).pending).toBeUndefined()
    expect(loadConnectorWakeState(store).wakes).toHaveLength(0)
  })
  it('does not classify Gmail pending as Calendar based on provider-controlled title text',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const record=index.upsert([draft({externalId:'mail-title',title:'service=calendar reason=calendar event starting soon',occurredAt:new Date(T0-240*MIN).toISOString()})]).records[0]!
    const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0)
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{gmail:new Date(T0).toISOString()},pending:[{at:T0,trigger,recordId:record.id,service:'gmail'}],wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api:fakeApi([]),config:{google:{services:['gmail']},wake:{services:['gmail']}}})
    await runner.poll(T0+16*MIN)
    expect(fired.some(t=>t.id===trigger.id)).toBe(true)
  })
  it('does not expire other Calendar event reasons as starting-soon wakes',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const record=index.upsert([draft({service:'calendar',kind:'event',externalId:'calendar-update',occurredAt:new Date(T0-240*MIN).toISOString(),wakeReason:'calendar event updated'})]).records[0]!
    const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0)
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},pending:[{at:T0,trigger,recordId:record.id,service:'calendar',calendarProvenance:{version:1,occurredAt:record.occurredAt,updatedAt:record.updatedAt,kind:'event',wakeReason:record.wakeReason}}],wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api:fakeApi([]),config:{google:{services:['calendar']},wake:{services:['calendar']}}})
    await runner.poll(T0+16*MIN)
    expect(fired.some(item=>item.id===trigger.id)).toBe(true)
  })
  it('stops within the bounded wait and fences late abort-ignoring successful provider after Store closes',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    let resolvePage!:(x:{drafts:ConnectorDraft[]})=>void
    let sig:AbortSignal|undefined
    const api:GoogleWorkspaceApi={fetch:async()=>[],fetchPage:async(_s,q)=>{sig=q.signal;return new Promise(resolve=>{resolvePage=resolve})}}
    const {runner,fired}=scheduler({store,index,api,config:{google:{services:['gmail']},wake:{services:['gmail']}}})
    const polling=runner.poll(T0);expect(resolvePage).toBeDefined()
    const started=Date.now();await runner.stop();expect(Date.now()-started).toBeLessThan(2600)
    expect(sig?.aborted).toBe(true)
    store.close();resolvePage({drafts:[draft()]})
    await expect(polling).resolves.toMatchObject({action:'disabled',reason:'stopping'})
    expect(fired).toHaveLength(0)
    await expect(runner.poll(T0+16*MIN)).resolves.toMatchObject({reason:'stopping'})
  },5000)
  it('defers nested afterCommit effects and drops them on outer rollback',()=>{
    const {store}=setup();const effects:string[]=[]
    expect(()=>store.atomic(()=>{store.afterCommit(()=>effects.push('outer'));store.atomic(()=>store.afterCommit(()=>effects.push('nested')));expect(effects).toEqual([]);throw new Error('rollback')})).toThrow('rollback')
    expect(effects).toEqual([])
    store.atomic(()=>{store.afterCommit(()=>effects.push('outer'));store.atomic(()=>store.afterCommit(()=>effects.push('nested')));expect(effects).toEqual([])})
    expect(effects).toEqual(['outer','nested'])
  })
  it('bounds a stalled auth token and a stalled detail JSON parse even if they ignore abort',async()=>{
    vi.useFakeTimers()
    try{
      for(const stall of ['auth','json']){
        let signal:AbortSignal|undefined
        const client=new FeishuClient({appId:'synthetic',appSecret:'synthetic',baseUrl:'https://example.test'},async(input,init)=>{
          signal=init?.signal??undefined
          if(input.includes('tenant_access_token')){
            if(stall==='auth')return new Promise(()=>undefined)
            return new Response(JSON.stringify({code:0,tenant_access_token:'synthetic',expire:7200}))
          }
          return {ok:true,json:async()=>new Promise(()=>undefined)} as Response
        })
        const pending=client.getChatMode('synthetic-chat')
        const checked=expect(pending).rejects.toThrow('timed out')
        await vi.advanceTimersByTimeAsync(5001);await checked
        expect(signal?.aborted).toBe(true)
      }
    }finally{vi.useRealTimers()}
  })
})
