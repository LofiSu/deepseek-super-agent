import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeProactiveConfig } from '../src/harness/proactive.ts'
import {
  ConnectorWakeScheduler,
  connectorTrigger,
  loadConnectorWakeState,
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



describe('executor additional lifecycle boundaries',()=>{
  it('rechecks current Calendar lookahead after restart instead of sending a now-too-early pending wake',async()=>{
    const {home,store,index}=setup();seedOwnerThread(store)
    const body={items:[{id:'restart-narrow-lookahead',summary:'Meeting',updated:new Date(T0).toISOString(),start:{dateTime:new Date(T0+60*MIN).toISOString()}}]}
    const originalApi=new HttpGoogleWorkspaceApi({accessToken:async()=> 'synthetic',invalidate:()=>undefined},{now:()=>T0,apiBase:'https://example.test',fetch:async()=>new Response(JSON.stringify(body))})
    store.putDoc('connector_wake','state',{lastCheckAt:T0-60*MIN,cursors:{calendar:new Date(T0-60*MIN).toISOString()},wakes:[],notified:[]})
    const first=scheduler({store,index,api:originalApi,now:()=>T0,config:{google:{services:['calendar']},wake:{services:['calendar'],calendarLookaheadMinutes:120}}})
    ;(first.runner as unknown as {opts:{fire:(t:Trigger)=>void}}).opts.fire=()=>{throw Error('synthetic ingress unavailable before commit')}
    await first.runner.poll(T0)
    const saved=loadConnectorWakeState(store).pending?.[0]
    expect(saved?.calendarProvenance).toMatchObject({version:1,occurredAt:new Date(T0+60*MIN).toISOString(),wakeReason:'calendar event starting soon'})
    expect(saved).toBeDefined()
    const trigger=saved!.trigger
    expect(store.getDoc('disposition',trigger.id)).toBeUndefined()
    store.close()
    const reopened=new Store(home);stores.push(reopened)
    const ri=new ConnectorIndex(reopened,{redact:t=>t,now:()=>new Date(T0+16*MIN)})
    const freshApi=new HttpGoogleWorkspaceApi({accessToken:async()=> 'synthetic',invalidate:()=>undefined},{now:()=>T0+16*MIN,apiBase:'https://example.test',fetch:async()=>new Response(JSON.stringify(body))})
    const current=await freshApi.fetchPage('calendar',{since:new Date(T0).toISOString(),until:new Date(T0+16*MIN).toISOString(),limit:25,lookaheadMinutes:15})
    expect(current.drafts[0]?.wake).toBe(false)
    let now=T0+16*MIN
    const {runner,fired}=scheduler({store:reopened,index:ri,api:freshApi,now:()=>now,config:{google:{services:['calendar']},wake:{services:['calendar'],calendarLookaheadMinutes:15}}})
    await runner.poll(now)
    expect(fired).toHaveLength(0)
    expect(loadConnectorWakeState(reopened).notified).toHaveLength(0)
    expect(loadConnectorWakeState(reopened).pending?.[0]?.trigger).toEqual(trigger)
    now=T0+45*MIN;await runner.poll(now)
    expect(fired).toEqual([trigger])
  })

  it('allows lookahead widening to admit the retained original pending revision',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const record=index.upsert([draft({service:'calendar',kind:'event',externalId:'widen-lookahead',occurredAt:new Date(T0+60*MIN).toISOString(),updatedAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})]).records[0]!
    const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0)
    const pending={at:T0,trigger,recordId:record.id,service:'calendar',calendarProvenance:{version:1,kind:'event' as const,occurredAt:record.occurredAt,updatedAt:record.updatedAt,wakeReason:record.wakeReason}}
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},pending:[pending],wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api:fakeApi([]),now:()=>T0+16*MIN,config:{google:{services:['calendar']},wake:{services:['calendar'],calendarLookaheadMinutes:120}}})
    await runner.poll(T0+16*MIN)
    expect(fired).toEqual([trigger])
  })

  it('defers a future Calendar wake without blocking an eligible Gmail wake or spending its cap',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const record=index.upsert([draft({service:'calendar',kind:'event',externalId:'future-does-not-block',occurredAt:new Date(T0+60*MIN).toISOString(),updatedAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})]).records[0]!
    const calendarTrigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0)
    const calendarPending={at:T0,trigger:calendarTrigger,recordId:record.id,service:'calendar',calendarProvenance:{version:1,kind:'event' as const,occurredAt:record.occurredAt,updatedAt:record.updatedAt,wakeReason:record.wakeReason}}
    const gmail=draft({service:'gmail',externalId:'healthy-gmail'})
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString(),gmail:new Date(T0).toISOString()},pending:[calendarPending],wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api:fakeApi([gmail]),now:()=>T0+16*MIN,config:{google:{services:['calendar','gmail']},wake:{services:['calendar','gmail'],calendarLookaheadMinutes:15}}})
    await runner.poll(T0+16*MIN)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.text).toContain('Invoice for November')
    const after=loadConnectorWakeState(store)
    expect(after.pending?.map(item=>item.trigger.id)).toContain(calendarTrigger.id)
    expect(after.notified.map(item=>item.triggerId)).not.toContain(calendarTrigger.id)
    expect(after.wakes).toHaveLength(1)
    expect(store.getDoc('disposition',calendarTrigger.id)).toBeUndefined()
  })

  it('keeps and self-heals the known intermediate duplicate-bucket fault after restart',async()=>{
    const {home,store,index}=setup();seedOwnerThread(store)
    const record=index.upsert([draft({service:'calendar',kind:'event',externalId:'repair-index-fault',occurredAt:new Date(T0+30*MIN).toISOString(),updatedAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})]).records[0]!
    const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0)
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},pending:[{at:T0,trigger,recordId:record.id,service:'calendar'}],wakes:[],notified:[]})
    let release!:(d:ConnectorDraft[])=>void
    const {runner,fired}=scheduler({store,index,api:{fetch:()=>new Promise(r=>{release=r})},now:()=>T0+16*MIN,config:{google:{services:['calendar']},wake:{services:['calendar']}}})
    const poll=runner.poll(T0+16*MIN);await Promise.resolve()
    const raw=store.getDoc<any>('connector_wake','state')!
    raw.uncertain[0].pending.calendarProvenance={version:1,kind:'event',occurredAt:record.occurredAt,updatedAt:record.updatedAt,wakeReason:record.wakeReason}
    store.putDoc('connector_wake','state',raw)
    index.upsert=()=>{throw Error('synthetic index write unavailable')}
    release([]);await expect(poll).rejects.toThrow('synthetic index write unavailable')
    expect(fired).toHaveLength(0);store.close()
    const reopened=new Store(home);stores.push(reopened)
    const st=loadConnectorWakeState(reopened)
    const buckets=[st.pending?.filter(p=>p.trigger.id===trigger.id).length??0,st.uncertain?.filter(x=>x.pending.trigger.id===trigger.id).length??0,st.incomplete?.filter(x=>x.pending.trigger.id===trigger.id).length??0]
    const originalBucketCount=buckets.reduce((a,b)=>a+b,0)
    const ri=new ConnectorIndex(reopened,{redact:t=>t,now:()=>new Date(T0+16*MIN)})
    const resumed=scheduler({store:reopened,index:ri,api:fakeApi([]),now:()=>T0+16*MIN,config:{google:{services:['calendar']},wake:{services:['calendar']}}})
    await resumed.runner.poll(T0+16*MIN)
    expect(resumed.fired).toEqual([trigger])
    expect(loadConnectorWakeState(reopened).wakes).toHaveLength(1)
    expect(loadConnectorWakeState(reopened).pending).toBeUndefined()
    expect(loadConnectorWakeState(reopened).uncertain).toBeUndefined()
    expect(originalBucketCount).toBe(2)
  })


  for(const role of ['uncertain','incomplete'] as const) it(`${role} recovery honors a narrowed current Calendar lookahead`,async()=>{
    const {home,store,index}=setup();seedOwnerThread(store)
    const record=index.upsert([draft({service:'calendar',kind:'event',externalId:`narrow-${role}`,occurredAt:new Date(T0+60*MIN).toISOString(),updatedAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})]).records[0]!
    const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0)
    const pending={at:T0,trigger,recordId:record.id,service:'calendar',calendarProvenance:{version:1,kind:'event',occurredAt:record.occurredAt,updatedAt:record.updatedAt,wakeReason:record.wakeReason}}
    const base={lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},wakes:[],notified:[]}
    store.putDoc('connector_wake','state',role==='uncertain'?{...base,uncertain:[{pending,reason:'calendar-provenance-unavailable',isolatedAt:T0}]}:{...base,incomplete:[{pending,reason:'legacy-routing-plan-unavailable',isolatedAt:T0}]})
    if(role==='incomplete'){store.putDoc('trigger',trigger.id,trigger);store.putDoc('intake_route_plan',trigger.id,{fanout:[],context:[],needsEval:true})}
    store.close();const reopened=new Store(home);stores.push(reopened)
    const ri=new ConnectorIndex(reopened,{redact:t=>t,now:()=>new Date(T0+16*MIN)})
    const {runner,fired}=scheduler({store:reopened,index:ri,api:fakeApi([]),now:()=>T0+16*MIN,config:{google:{services:['calendar']},wake:{services:['calendar'],calendarLookaheadMinutes:15}}})
    await runner.poll(T0+16*MIN)
    expect(fired).toHaveLength(0)
    const after=loadConnectorWakeState(reopened)
    expect(after.wakes).toHaveLength(0)
    expect(after.notified).toHaveLength(0)
    expect(after.pending?.[0]).toMatchObject({trigger,calendarProvenance:pending.calendarProvenance})
  })

  for(const role of ['fresh','pending','uncertain','incomplete'] as const) for(const delta of [15*MIN,15*MIN+1]) {
    it(`${role} uses inclusive current cutoff at offset ${delta}`,async()=>{
      const {store,index}=setup();seedOwnerThread(store)
      const d=draft({service:'calendar',kind:'event',externalId:`matrix-${role}-${delta}`,occurredAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})
      const record=index.upsert([d]).records[0]!
      const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0)
      const p={at:T0,trigger,recordId:record.id,service:'calendar',calendarProvenance:{version:1,kind:'event',occurredAt:record.occurredAt,updatedAt:record.updatedAt,wakeReason:record.wakeReason}}
      const base={lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},wakes:[],notified:[]}
      const st=role==='pending'?{...base,pending:[p]}:role==='uncertain'?{...base,uncertain:[{pending:p,reason:'calendar-provenance-unavailable',isolatedAt:T0}]}:role==='incomplete'?{...base,incomplete:[{pending:p,reason:'legacy-routing-plan-unavailable',isolatedAt:T0}]}:base
      store.putDoc('connector_wake','state',st)
      const {runner,fired}=scheduler({store,index,api:fakeApi(role==='fresh'?[d]:[]),now:()=>T0+delta,config:{google:{services:['calendar']},wake:{services:['calendar']}}})
      await runner.poll(T0+delta)
      expect(fired).toHaveLength(delta===15*MIN?1:0)
      expect(loadConnectorWakeState(store).wakes).toHaveLength(delta===15*MIN?1:0)
      if(role!=='fresh'&&delta===15*MIN)expect(fired[0]).toEqual(trigger)
    })
  }
})
