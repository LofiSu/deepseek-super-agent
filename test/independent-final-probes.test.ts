import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeProactiveConfig } from '../src/harness/proactive.ts'
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



describe('independent final revision probes', () => {
  it('revalidates a fresh Calendar wake at decision time after a later slow provider', async () => {
    const {store,index}=setup();seedOwnerThread(store)
    let now=T0
    const api=new HttpGoogleWorkspaceApi({accessToken:async()=> 'synthetic',invalidate:()=>undefined},{now:()=>now,apiBase:'https://example.test',fetch:async(input)=> {
      if(String(input).includes('/calendar/')) return new Response(JSON.stringify({items:[{id:'fresh-expiry',summary:'Meeting',updated:new Date(T0).toISOString(),start:{dateTime:new Date(T0).toISOString()}}]}))
      now=T0+30*MIN;return new Response(JSON.stringify({messages:[]}))
    }})
    store.putDoc('connector_wake','state',{lastCheckAt:T0-60*MIN,cursors:{calendar:new Date(T0-60*MIN).toISOString(),gmail:new Date(T0-60*MIN).toISOString()},wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api,now:()=>now,config:{google:{services:['calendar','gmail']},wake:{services:['calendar'],calendarLookaheadMinutes:120}}})
    await runner.poll(T0)
    expect(now).toBe(T0+30*MIN)
    expect(fired).toHaveLength(0)
    expect(loadConnectorWakeState(store).wakes).toHaveLength(0)
  })

  it('does not spend cap or mark notified when the same incomplete source revision is polled again',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const item=pendingWake(index,T0,'same-revision')
    store.putDoc('trigger',item.trigger.id,item.trigger)
    store.putDoc('intake_recovery',item.trigger.id,{triggerId:item.trigger.id,reason:'legacy-routing-plan-unavailable'})
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{gmail:new Date(T0).toISOString()},pending:[item],wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api:fakeApi([draft({externalId:'pending-same-revision'})]),config:{google:{services:['gmail']},wake:{services:['gmail']}}})
    await runner.poll(T0+16*MIN)
    const state=loadConnectorWakeState(store)
    expect(fired).toHaveLength(0)
    expect(state.incomplete?.[0]?.pending).toEqual(item)
    expect(state.wakes).toHaveLength(0)
    expect(state.notified.some(row=>row.triggerId===item.trigger.id)).toBe(false)
  })

  it('does not move lastWakeAt backwards when isolated wakes finish in reverse completion order',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const a=pendingWake(index,T0,'later-completed-a'),b=pendingWake(index,T0,'earlier-completed-b')
    for(const [p,offset] of [[a,50],[b,30]] as const){store.putDoc('trigger',p.trigger.id,p.trigger);store.putDoc('disposition',p.trigger.id,{at:new Date(T0+offset*MIN).toISOString(),fanout:[]})}
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{gmail:new Date(T0).toISOString()},incomplete:[{pending:a,reason:'legacy-routing-plan-unavailable',isolatedAt:T0},{pending:b,reason:'legacy-routing-plan-unavailable',isolatedAt:T0}],wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api:fakeApi([draft({externalId:'must-wait',occurredAt:new Date(T0+60*MIN).toISOString(),updatedAt:new Date(T0+60*MIN).toISOString()})]),now:()=>T0+61*MIN,config:{google:{services:['gmail']},wake:{services:['gmail'],minIntervalMinutes:15,maxPerDay:24}}})
    await runner.poll(T0+61*MIN)
    expect(fired).toHaveLength(0)
    expect(loadConnectorWakeState(store).lastWakeAt).toBe(T0+50*MIN)
  })

  it('applies the same final-time Calendar cutoff to pending and repaired isolated revisions',async()=>{
    for (const lifecycle of ['pending','uncertain'] as const) {
      const {store,index}=setup();seedOwnerThread(store)
      const record=index.upsert([draft({service:'calendar',kind:'event',externalId:`cutoff-${lifecycle}`,occurredAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})]).records[0]!
      const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0)
      const provenance={version:1 as const,occurredAt:record.occurredAt,updatedAt:record.updatedAt,kind:'event' as const,wakeReason:record.wakeReason}
      const item={at:T0,trigger,recordId:record.id,service:'calendar' as const,calendarProvenance:provenance}
      const state=lifecycle==='pending'
        ? {lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},pending:[item],wakes:[],notified:[]}
        : {lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},uncertain:[{pending:item,reason:'calendar-provenance-unavailable',isolatedAt:T0}],wakes:[],notified:[]}
      store.putDoc('connector_wake','state',state)
      const {runner,fired}=scheduler({store,index,api:fakeApi([]),now:()=>T0+15*MIN+1,config:{google:{services:['calendar']},wake:{services:['calendar']}}})
      await runner.poll(T0+15*MIN+1)
      expect(fired).toHaveLength(0)
      expect(loadConnectorWakeState(store).wakes).toHaveLength(0)
      expect(loadConnectorWakeState(store).pending).toBeUndefined()
      expect(loadConnectorWakeState(store).uncertain).toBeUndefined()
    }
  })

  it('aggregates every completion permutation against the existing monotonic watermark',async()=>{
    const permutations=[[30,40,50],[30,50,40],[40,30,50],[40,50,30],[50,30,40],[50,40,30]] as const
    for (const [round,order] of permutations.entries()) {
      const {store,index}=setup();seedOwnerThread(store)
      const offsets=[30,40,50] as const
      const rows=offsets.map(offset=>pendingWake(index,T0,`perm-${round}-${offset}`))
      for (const [pending,offset] of rows.map((row,i)=>[row,offsets[i]!] as const)) {
        store.putDoc('trigger',pending.trigger.id,pending.trigger)
        store.putDoc('disposition',pending.trigger.id,{at:new Date(T0+offset*MIN).toISOString(),fanout:[]})
      }
      store.putDoc('connector_wake','state',{lastCheckAt:T0,lastWakeAt:T0+55*MIN,cursors:{gmail:new Date(T0).toISOString()},incomplete:order.map(offset=>({pending:rows[offsets.indexOf(offset)]!,reason:'legacy-routing-plan-unavailable',isolatedAt:T0})),wakes:[],notified:[]})
      const {runner,fired}=scheduler({store,index,api:fakeApi([draft({externalId:`after-perm-${round}`,occurredAt:new Date(T0+60*MIN).toISOString(),updatedAt:new Date(T0+60*MIN).toISOString()})]),now:()=>T0+61*MIN,config:{google:{services:['gmail']},wake:{services:['gmail'],minIntervalMinutes:15,maxPerDay:24}}})
      await runner.poll(T0+61*MIN)
      const state=loadConnectorWakeState(store)
      expect(fired).toHaveLength(0)
      expect(state.lastWakeAt).toBe(T0+55*MIN)
      expect(state.wakes.map(row=>row.at).sort((a,b)=>a-b)).toEqual(offsets.map(offset=>T0+offset*MIN).sort((a,b)=>a-b))
    }
  })

  it('retains a durable trusted provenance repair written while a provider request is pending',async()=>{
    const {home,store,index}=setup();seedOwnerThread(store)
    const record=index.upsert([draft({service:'calendar',kind:'event',externalId:'repair-race',occurredAt:new Date(T0+30*MIN).toISOString(),updatedAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})]).records[0]!
    const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0)
    const p={at:T0,trigger,recordId:record.id,service:'calendar'} as const
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},pending:[p],wakes:[],notified:[]})
    let resolve!:(value:ConnectorDraft[])=>void
    const api:GoogleWorkspaceApi={fetch:()=>new Promise(r=>{resolve=r})}
    const {runner}=scheduler({store,index,api,now:()=>T0+16*MIN,config:{google:{services:['calendar']},wake:{services:['calendar']}}})
    const poll=runner.poll(T0+16*MIN)
    await Promise.resolve()
    const isolated=store.getDoc<any>('connector_wake','state')!
    expect(isolated.uncertain).toHaveLength(1)
    isolated.uncertain[0].pending.calendarProvenance={version:1,occurredAt:record.occurredAt,updatedAt:record.updatedAt,kind:'event',wakeReason:record.wakeReason}
    store.putDoc('connector_wake','state',isolated)
    resolve([]);await poll
    const state=loadConnectorWakeState(store)
    expect(state.uncertain).toBeUndefined()
    expect(state.pending?.[0]?.trigger.id).toBe(trigger.id)
    expect(state.pending?.[0]?.calendarProvenance?.version).toBe(1)
    expect(state.pending?.[0]?.trigger).toEqual(trigger)
    store.close()
    const reopened=new Store(home);stores.push(reopened)
    const recovered=loadConnectorWakeState(reopened)
    expect(recovered.pending?.[0]?.trigger.id).toBe(trigger.id)
    expect(recovered.pending?.[0]?.calendarProvenance?.version).toBe(1)
    expect(recovered.pending?.[0]?.trigger.text).toBe(trigger.text)
  })

  it('does not resurrect a concurrently completed and removed isolated revision',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const item=pendingWake(index,T0,'completed-race')
    store.putDoc('trigger',item.trigger.id,item.trigger)
    store.putDoc('intake_recovery',item.trigger.id,{triggerId:item.trigger.id,reason:'legacy-routing-plan-unavailable'})
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{gmail:new Date(T0).toISOString()},pending:[item],wakes:[],notified:[]})
    let resolve!:(value:ConnectorDraft[])=>void
    const api:GoogleWorkspaceApi={fetch:()=>new Promise(r=>{resolve=r})}
    const {runner,fired}=scheduler({store,index,api,now:()=>T0+16*MIN,config:{google:{services:['gmail']},wake:{services:['gmail']}}})
    const poll=runner.poll(T0+16*MIN)
    await Promise.resolve()
    const latest=store.getDoc<any>('connector_wake','state')!
    latest.incomplete=[]
    latest.pending=[]
    store.putDoc('connector_wake','state',latest)
    store.putDoc('disposition',item.trigger.id,{at:new Date(T0+15*MIN).toISOString(),fanout:[]})
    resolve([]);await poll
    const state=loadConnectorWakeState(store)
    expect(state.pending).toBeUndefined()
    expect(state.incomplete).toBeUndefined()
    expect(state.wakes.some(row=>row.triggerId===item.trigger.id)).toBe(false)
    expect(fired).toHaveLength(0)
  })

  it('commits isolation as one durable state write; a rejected state write cannot lose original pending',async()=>{
    const {home,store,index}=setup();seedOwnerThread(store)
    const item=pendingWake(index,T0,'atomic-isolation')
    store.putDoc('trigger',item.trigger.id,item.trigger)
    store.putDoc('intake_recovery',item.trigger.id,{triggerId:item.trigger.id,reason:'legacy-routing-plan-unavailable'})
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{gmail:new Date(T0).toISOString()},pending:[item],wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api:fakeApi([]),config:{google:{services:['gmail']},wake:{services:['gmail']}}})
    const original=store.putDoc.bind(store)
    store.putDoc=((kind:string,id:string,value:unknown)=>{if(kind==='connector_wake'&&(value as {incomplete?:unknown[]}).incomplete?.length)throw Error('synthetic commit unavailable');return original(kind,id,value)}) as typeof store.putDoc
    await expect(runner.poll(T0+16*MIN)).rejects.toThrow('synthetic commit unavailable')
    expect(fired).toHaveLength(0)
    store.putDoc=original;store.close()
    const reopened=new Store(home);stores.push(reopened)
    const state=loadConnectorWakeState(reopened)
    expect(state.pending?.[0]).toEqual(item)
    expect(state.incomplete).toBeUndefined()
    expect(state.wakes).toHaveLength(0)
  })

  it('retains the same incomplete payload if isolation commits but its acknowledgement is lost',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const item=pendingWake(index,T0,'lost-isolation-ack')
    store.putDoc('trigger',item.trigger.id,item.trigger)
    store.putDoc('intake_recovery',item.trigger.id,{triggerId:item.trigger.id,reason:'legacy-routing-plan-unavailable'})
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{gmail:new Date(T0).toISOString()},pending:[item],wakes:[],notified:[]})
    const {runner,fired}=scheduler({store,index,api:fakeApi([]),config:{google:{services:['gmail']},wake:{services:['gmail']}}})
    const orig=store.putDoc.bind(store);let failed=false
    store.putDoc=((kind:string,id:string,value:unknown)=>{const result=orig(kind,id,value);if(!failed&&kind==='connector_wake'&&(value as {incomplete?:unknown[]}).incomplete?.length){failed=true;throw Error('synthetic ack lost')}return result}) as typeof store.putDoc
    await expect(runner.poll(T0+16*MIN)).rejects.toThrow('synthetic ack lost')
    store.putDoc=orig
    await runner.poll(T0+32*MIN)
    const state=loadConnectorWakeState(store)
    expect(state.incomplete).toHaveLength(1)
    expect(state.incomplete?.[0]?.pending).toEqual(item)
    expect(state.pending).toBeUndefined()
    expect(fired).toHaveLength(0)
    expect(state.notified).toHaveLength(0)
  })

  it('can recover uncertain original provenance after Store close/reopen without changing identity/payload',async()=>{
    const {home,store,index}=setup();seedOwnerThread(store)
    const record=index.upsert([draft({service:'calendar',kind:'event',externalId:'trusted-repair',occurredAt:new Date(T0+30*MIN).toISOString(),updatedAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})]).records[0]!
    const trigger=connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0)
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{calendar:new Date(T0).toISOString()},uncertain:[{pending:{at:T0,trigger,recordId:record.id,service:'calendar'},reason:'calendar-provenance-unavailable',isolatedAt:T0}],wakes:[],notified:[]})
    store.close();const reopened=new Store(home);stores.push(reopened)
    const raw=reopened.getDoc<any>('connector_wake','state')!
    raw.uncertain[0].pending.calendarProvenance={version:1,occurredAt:record.occurredAt,updatedAt:record.updatedAt,kind:'event',wakeReason:record.wakeReason}
    reopened.putDoc('connector_wake','state',raw)
    const ri=new ConnectorIndex(reopened,{redact:t=>t,now:()=>new Date(T0)})
    const {runner,fired}=scheduler({store:reopened,index:ri,api:fakeApi([]),now:()=>T0+16*MIN,config:{google:{services:['calendar']},wake:{services:['calendar']}}})
    await runner.poll(T0+16*MIN);await runner.poll(T0+32*MIN)
    expect(fired).toEqual([trigger])
    expect(loadConnectorWakeState(reopened).uncertain).toBeUndefined()
    expect(loadConnectorWakeState(reopened).wakes).toHaveLength(1)
  })

  it('keeps advancing page checkpoints and reaches later useful wake after diagnosed incomplete ingress',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const bad=draft({externalId:'page1-poison'}),good=draft({externalId:'page2-useful',occurredAt:new Date(T0+10*MIN).toISOString(),updatedAt:new Date(T0+10*MIN).toISOString()})
    const badRecord=index.upsert([bad]).records[0]!;const badId=`trg_connector_${badRecord.id}_${badRecord.updatedAt}`
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{gmail:new Date(T0).toISOString()},wakes:[],notified:[]})
    const queries:(string|undefined)[]=[]
    const api:GoogleWorkspaceApi={fetch:async()=>[],fetchPage:async(_service,q)=>{queries.push(q.pageToken);return q.pageToken?{drafts:[good]}:{drafts:[bad],nextPageToken:'page2'}}}
    const {runner}=scheduler({store,index,api,config:{google:{services:['gmail']},wake:{services:['gmail'],maxPerDay:10}}})
    const attempts:Trigger[]=[]
    ;(runner as unknown as {opts:{fire:(t:Trigger)=>void}}).opts.fire=t=>{attempts.push(t);store.putDoc('trigger',t.id,t);if(t.id===badId)store.putDoc('intake_recovery',t.id,{triggerId:t.id,reason:'legacy-routing-plan-unavailable'});else store.putDoc('disposition',t.id,{at:new Date(T0+32*MIN).toISOString(),fanout:[]})}
    await runner.poll(T0+16*MIN);await runner.poll(T0+32*MIN)
    expect(queries).toEqual([undefined,'page2'])
    expect(attempts).toHaveLength(2)
    expect(attempts[1]?.id).not.toBe(badId)
    const state=loadConnectorWakeState(store)
    expect(state.incomplete).toHaveLength(1)
    expect(state.wakes).toHaveLength(1)
    expect(state.cursors?.gmail).toBe(new Date(T0+16*MIN).toISOString())
  })

  it('diagnostic: isolated entries are not evicted at wake/notified caps',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const item=pendingWake(index,T0,'capacity')
    const items=Array.from({length:300},(_,i)=>({pending:{...item,trigger:{...item.trigger,id:`capacity-${i}`,text:'x'.repeat(4096)}},reason:'legacy-routing-plan-unavailable',isolatedAt:T0}))
    for(const i of items)store.putDoc('intake_recovery',i.pending.trigger.id,{triggerId:i.pending.trigger.id})
    store.putDoc('connector_wake','state',{lastCheckAt:T0,cursors:{gmail:new Date(T0).toISOString()},incomplete:items,wakes:[],notified:[]})
    const {runner}=scheduler({store,index,api:fakeApi([]),config:{google:{services:['gmail']},wake:{services:['gmail']}}})
    await runner.poll(T0+16*MIN)
    expect(loadConnectorWakeState(store).incomplete).toHaveLength(300)
    expect(JSON.stringify(store.getDoc('connector_wake','state')).length).toBeGreaterThan(1200000)
  })
})
