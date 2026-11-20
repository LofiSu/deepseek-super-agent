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




import type { ConnectorPendingWake } from '../src/connectors/wake.ts'
import type { GoogleFetchQuery } from '../src/connectors/google.ts'

function queued(index: ConnectorIndex, id: string, start: number, service: 'calendar'|'gmail' = 'calendar'): ConnectorPendingWake {
  const r = index.upsert([draft({service,kind:service==='calendar'?'event':'message',externalId:id,
    occurredAt:new Date(start).toISOString(),updatedAt:new Date(T0).toISOString(),
    wakeReason:service==='calendar'?'calendar event starting soon':'unread important mail',title:id})]).records[0]!
  return {at:T0,recordId:r.id,service:r.service,
    trigger:connectorTrigger(r,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0),
    ...(service==='calendar'?{calendarProvenance:{version:1 as const,kind:'event' as const,occurredAt:r.occurredAt,updatedAt:r.updatedAt,wakeReason:r.wakeReason}}:{})}
}
function seed(store:Store,pending:ConnectorPendingWake[],extra:Record<string,unknown>={}) {
  store.putDoc('connector_wake','state',{lastCheckAt:T0-60*MIN,
    cursors:{calendar:new Date(T0-60*MIN).toISOString(),gmail:new Date(T0-60*MIN).toISOString()},
    pending,wakes:[],notified:[],...extra})
}
function commitAt(s:ReturnType<typeof scheduler>,store:Store,now:()=>number) {
  ;(s.runner as unknown as {opts:{fire:(t:Trigger)=>void}}).opts.fire=t=>{
    s.fired.push(t);store.putDoc('trigger',t.id,t)
    store.putDoc('disposition',t.id,{at:new Date(now()).toISOString(),fanout:[],context:[]} satisfies Disposition)
  }
}
function cfg(lookahead=15) {return {google:{services:['calendar','gmail']},wake:{services:['calendar','gmail'],calendarLookaheadMinutes:lookahead}}}

describe('executor new full-current-window functional probes',()=>{
  it('real create/fail, two restarts/shrinks, mutable-index drift, widening releases ONE immutable original with actual disposition accounting',async()=>{
    const {home,store,index}=setup();seedOwnerThread(store);seed(store,[])
    const body={items:[{id:'new-real-chain',summary:'ORIGINAL',updated:new Date(T0).toISOString(),start:{dateTime:new Date(T0+60*MIN).toISOString()}}]}
    const api=new HttpGoogleWorkspaceApi({accessToken:async()=> 'fixture-only',invalidate:()=>undefined},{now:()=>T0,apiBase:'https://example.test',fetch:async()=>new Response(JSON.stringify(body))})
    const a=scheduler({store,index,api,now:()=>T0,config:cfg(120)})
    ;(a.runner as unknown as {opts:{fire:()=>void}}).opts.fire=()=>{throw Error('ingress unavailable before commit')}
    await a.runner.poll(T0);const original=loadConnectorWakeState(store).pending![0]!
    expect(original.calendarProvenance?.occurredAt).toBe(new Date(T0+60*MIN).toISOString())
    store.close()
    let current=new Store(home);stores.push(current);let ci=new ConnectorIndex(current,{redact:t=>t,now:()=>new Date(T0)})
    let now=T0+16*MIN;const b=scheduler({store:current,index:ci,api:fakeApi([]),now:()=>now,config:cfg(15)});commitAt(b,current,()=>now)
    await b.runner.poll(now);expect(b.fired).toEqual([]);expect(loadConnectorWakeState(current).pending).toEqual([original])
    ci.upsert([draft({service:'calendar',kind:'event',externalId:'new-real-chain',title:'MUTATED INDEX',occurredAt:new Date(T0+200*MIN).toISOString(),updatedAt:new Date(T0+10*MIN).toISOString(),wakeReason:'calendar event starting soon'})])
    current.close();current=new Store(home);stores.push(current);ci=new ConnectorIndex(current,{redact:t=>t,now:()=>new Date(T0)})
    now=T0+32*MIN;const c=scheduler({store:current,index:ci,api:fakeApi([]),now:()=>now,config:cfg(5)});commitAt(c,current,()=>now)
    await c.runner.poll(now);expect(c.fired).toEqual([]);expect(loadConnectorWakeState(current).pending).toEqual([original]);expect(loadConnectorWakeState(current).notified).toEqual([])
    current.close();current=new Store(home);stores.push(current);ci=new ConnectorIndex(current,{redact:t=>t,now:()=>new Date(T0)})
    now=T0+33*MIN;const d=scheduler({store:current,index:ci,api:fakeApi([]),now:()=>now,config:cfg(30)});commitAt(d,current,()=>now)
    await d.runner.poll(now);expect(d.fired).toEqual([original.trigger]);let st=loadConnectorWakeState(current)
    expect(st.wakes).toMatchObject([{at:now,triggerId:original.trigger.id}]);expect(st.lastWakeAt).toBe(now);expect(st.pending).toBeUndefined()
    now=T0+50*MIN;await d.runner.poll(now);expect(d.fired).toHaveLength(1);st=loadConnectorWakeState(current);expect(st.wakes).toHaveLength(1)
  })
  it('skips TWO not-yet heads to fire an eligible pending Gmail, then releases original future rows in window with monotonic receipt times',async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const p=queued(index,'future-head-1',T0+120*MIN),q=queued(index,'future-head-2',T0+150*MIN),g=queued(index,'pending-gmail',T0,'gmail');seed(store,[p,q,g])
    let now=T0+16*MIN;const s=scheduler({store,index,api:fakeApi([]),now:()=>now,config:cfg()});commitAt(s,store,()=>now)
    await s.runner.poll(now);expect(s.fired).toEqual([g.trigger]);expect(loadConnectorWakeState(store).pending).toEqual([p,q]);expect(loadConnectorWakeState(store).notified.map(x=>x.triggerId)).toEqual([g.trigger.id])
    now=T0+105*MIN;await s.runner.poll(now);expect(s.fired).toEqual([g.trigger,p.trigger]);expect(loadConnectorWakeState(store).pending).toEqual([q])
    now=T0+135*MIN;await s.runner.poll(now);const st=loadConnectorWakeState(store);expect(s.fired).toEqual([g.trigger,p.trigger,q.trigger]);expect(st.pending).toBeUndefined()
    expect(st.wakes.map(x=>x.at)).toEqual([T0+16*MIN,T0+105*MIN,T0+135*MIN]);expect(st.lastWakeAt).toBe(now)
  })
  it('keeps a future payload while Gmail page2 advances its ORIGINAL bound, then delivers future once',async()=>{
    const {store,index}=setup();seedOwnerThread(store);const p=queued(index,'future-paged',T0+120*MIN);seed(store,[p])
    const queries:GoogleFetchQuery[]=[];let n=0;let now=T0+16*MIN
    const api:GoogleWorkspaceApi={fetch:async()=>[],fetchPage:async(service,query)=>{
      if(service!=='gmail')return {drafts:[]};queries.push({...query});n++
      return {drafts:[draft({externalId:n===2?'page-two':'page-one'})],...(n===1?{nextPageToken:'second-page'}:{})}
    }}
    const s=scheduler({store,index,api,now:()=>now,config:cfg()});commitAt(s,store,()=>now)
    await s.runner.poll(now);expect(s.fired).toHaveLength(1);expect(loadConnectorWakeState(store).pending).toEqual([p]);expect(loadConnectorWakeState(store).pageTokens?.gmail).toBe('second-page')
    now=T0+32*MIN;await s.runner.poll(now);let st=loadConnectorWakeState(store);expect(s.fired).toHaveLength(2);expect(queries[1]?.pageToken).toBe('second-page');expect(queries[1]?.until).toBe(new Date(T0+16*MIN).toISOString());expect(st.cursors?.gmail).toBe(queries[0]?.until);expect(st.pending).toEqual([p]);expect(st.wakes).toHaveLength(2);expect(st.notified.some(x=>x.triggerId===p.trigger.id)).toBe(false)
    now=T0+105*MIN;await s.runner.poll(now);st=loadConnectorWakeState(store);expect(s.fired[2]).toEqual(p.trigger);expect(st.wakes).toHaveLength(3);expect(st.lastWakeAt).toBe(now);expect(st.pending).toBeUndefined()
  })
  for(const role of ['uncertain','incomplete'] as const) it(`${role} is durably repaired, narrowed, reopened, deferred and eventually fires original at exact front edge`,async()=>{
    const {home,store,index}=setup();seedOwnerThread(store);const p=queued(index,`repair-followthrough-${role}`,T0+60*MIN)
    const unknown={...p};delete unknown.calendarProvenance;seed(store,[unknown]);if(role==='incomplete')store.putDoc('intake_recovery',p.trigger.id,{triggerId:p.trigger.id,reason:'legacy-routing-plan-unavailable'})
    const a=scheduler({store,index,api:fakeApi([]),now:()=>T0+16*MIN,config:cfg()});await a.runner.poll(T0+16*MIN);expect(a.fired).toEqual([])
    const raw=store.getDoc<any>('connector_wake','state')!;expect(raw[role]).toHaveLength(1);raw[role][0].pending.calendarProvenance=p.calendarProvenance;store.putDoc('connector_wake','state',raw)
    if(role==='incomplete'){store.putDoc('trigger',p.trigger.id,p.trigger);store.putDoc('intake_route_plan',p.trigger.id,{fanout:[],context:[],needsEval:true});store.deleteDoc('intake_recovery',p.trigger.id)}
    store.close();const rs=new Store(home);stores.push(rs);const ri=new ConnectorIndex(rs,{redact:t=>t,now:()=>new Date(T0)})
    let now=T0+32*MIN;const b=scheduler({store:rs,index:ri,api:fakeApi([]),now:()=>now,config:cfg()});commitAt(b,rs,()=>now)
    await b.runner.poll(now);expect(b.fired).toEqual([]);expect(loadConnectorWakeState(rs).pending).toEqual([p]);expect(loadConnectorWakeState(rs).notified).toEqual([])
    now=T0+45*MIN;await b.runner.poll(now);expect(b.fired).toEqual([p.trigger]);expect(loadConnectorWakeState(rs).wakes).toMatchObject([{at:now,triggerId:p.trigger.id}]);expect(loadConnectorWakeState(rs).pending).toBeUndefined()
  })
  it('retires a deferred original only AFTER inclusive grace, without charging it or blocking Gmail',async()=>{
    const {home,store,index}=setup();seedOwnerThread(store);const p=queued(index,'defer-then-expire',T0+60*MIN);seed(store,[p]);const a=scheduler({store,index,api:fakeApi([]),now:()=>T0+16*MIN,config:cfg()});await a.runner.poll(T0+16*MIN);expect(a.fired).toEqual([]);store.close()
    const rs=new Store(home);stores.push(rs);const ri=new ConnectorIndex(rs,{redact:t=>t,now:()=>new Date(T0)});const now=T0+75*MIN+1
    const b=scheduler({store:rs,index:ri,api:fakeApi([draft({externalId:'after-expiry-gmail'})]),now:()=>now,config:cfg()});commitAt(b,rs,()=>now);await b.runner.poll(now)
    const st=loadConnectorWakeState(rs);expect(b.fired).toHaveLength(1);expect(b.fired[0]?.id).not.toBe(p.trigger.id);expect(rs.getDoc('disposition',p.trigger.id)).toBeUndefined();expect(st.pending).toBeUndefined();expect(st.notified.some(x=>x.triggerId===p.trigger.id)).toBe(true);expect(st.wakes).toHaveLength(1);expect(st.lastWakeAt).toBe(now)
  })
  for(const gate of ['wake-disabled','quiet','service-disabled','actor-denied','daily-cap','min-interval'] as const) it(`future release still honors ${gate} and can later retry original`,async()=>{
    const {store,index}=setup();seedOwnerThread(store);const p=queued(index,`gate-${gate}`,T0+60*MIN);seed(store,[p]);let now=T0+16*MIN
    const opts:any={store,index,api:fakeApi([]),now:()=>now,config:cfg()}
    if(gate==='wake-disabled')opts.config.wake.enabled=false
    if(gate==='quiet')opts.quiet={quietStart:'00:00',quietEnd:'23:59',timezone:'UTC'}
    if(gate==='service-disabled')opts.config.wake.services=['gmail']
    if(gate==='actor-denied')opts.admission={actors:['not-the-owner']}
    if(gate==='daily-cap'){opts.config.wake.maxPerDay=1;const st=loadConnectorWakeState(store);store.putDoc('connector_wake','state',{...st,lastWakeAt:T0+MIN,wakes:[{at:T0+MIN,triggerId:'already-delivered',recordId:'already-delivered',service:'gmail'}]})}
    const a=scheduler(opts);commitAt(a,store,()=>now);await a.runner.poll(now);expect(a.fired).toEqual([]);expect(loadConnectorWakeState(store).pending).toEqual([p])
    if(gate==='min-interval'){const st=loadConnectorWakeState(store);store.putDoc('connector_wake','state',{...st,lastWakeAt:T0+31*MIN,wakes:[{at:T0+31*MIN,triggerId:'healthy-31',recordId:'healthy-31',service:'gmail'}]})}
    now=T0+45*MIN;await a.runner.poll(now);expect(a.fired).toEqual([]);expect(loadConnectorWakeState(store).pending).toEqual([p]);expect(loadConnectorWakeState(store).notified.some(x=>x.triggerId===p.trigger.id)).toBe(false)
    now=T0+62*MIN;const b=scheduler({store,index,api:fakeApi([]),now:()=>now,config:cfg()});commitAt(b,store,()=>now);await b.runner.poll(now);expect(b.fired).toEqual([p.trigger]);expect(loadConnectorWakeState(store).pending).toBeUndefined();expect(loadConnectorWakeState(store).lastWakeAt).toBe(now)
  })
  for(const role of ['fresh','pending','uncertain','incomplete'] as const)for(const delta of [-1,0])it(`${role} front window is inclusive, offset ${delta}ms`,async()=>{
    const {store,index}=setup();seedOwnerThread(store);const p=queued(index,`front-${role}-${delta}`,T0+60*MIN);seed(store,[])
    const st=loadConnectorWakeState(store)
    if(role==='pending')store.putDoc('connector_wake','state',{...st,pending:[p]})
    if(role==='uncertain')store.putDoc('connector_wake','state',{...st,uncertain:[{pending:p,reason:'calendar-provenance-unavailable',isolatedAt:T0}]})
    if(role==='incomplete'){store.putDoc('trigger',p.trigger.id,p.trigger);store.putDoc('intake_route_plan',p.trigger.id,{fanout:[],context:[],needsEval:true});store.putDoc('connector_wake','state',{...st,incomplete:[{pending:p,reason:'legacy-routing-plan-unavailable',isolatedAt:T0}]})}
    const now=T0+45*MIN+delta
    const api=fakeApi(role==='fresh'?[draft({service:'calendar',kind:'event',externalId:`front-${role}-${delta}`,occurredAt:new Date(T0+60*MIN).toISOString(),updatedAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})]:[])
    const s=scheduler({store,index,api,now:()=>now,config:cfg()});commitAt(s,store,()=>now);await s.runner.poll(now)
    expect(s.fired).toHaveLength(delta===0?1:0);expect(loadConnectorWakeState(store).wakes).toHaveLength(delta===0?1:0)
    if(delta===-1&&role!=='fresh')expect(loadConnectorWakeState(store).pending).toEqual([p])
  })
})

describe('executor final-clock-after-synchronous-work counterexamples',()=>{
  for(const stage of ['fresh-index-real-2s','fresh-checkpoint','pending-target-scan'] as const)it(`${stage}: must not fire AFTER original Calendar grace because the sampled gate time was earlier`,async()=>{
    const {store,index}=setup();seedOwnerThread(store)
    const d=draft({service:'calendar',kind:'event',externalId:`clock-${stage}`,occurredAt:new Date(T0).toISOString(),updatedAt:new Date(T0-10*MIN).toISOString(),wakeReason:'calendar event starting soon'})
    const record=index.upsert([d]).records[0]!;const p:ConnectorPendingWake={at:T0,recordId:record.id,service:'calendar',trigger:connectorTrigger(record,{channel:{source:'cli',thread:'local'},actor:{source:'cli',id:'you'}},T0),calendarProvenance:{version:1,kind:'event',occurredAt:record.occurredAt,updatedAt:record.updatedAt,wakeReason:record.wakeReason}}
    seed(store,stage==='pending-target-scan'?[p]:[])
    const initial=T0+15*MIN-1000;let simulated=initial;let wallStart:number|undefined;const now=()=>wallStart===undefined?simulated:initial+Date.now()-wallStart
    let delayed=false
    if(stage==='fresh-index-real-2s'){
      const upsert=index.upsert.bind(index);index.upsert=items=>{const result=upsert(items);if(!delayed){delayed=true;wallStart=Date.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000)}return result}
    }
    if(stage==='fresh-checkpoint'){
      const put=store.putDoc.bind(store);store.putDoc=((kind:string,id:string,value:unknown)=>{const result=put(kind,id,value);if(!delayed&&kind==='connector_wake'&&(value as {pending?:unknown[]}).pending?.length){delayed=true;simulated+=2000}return result}) as typeof store.putDoc
    }
    if(stage==='pending-target-scan'){
      const list=store.listDocs.bind(store);store.listDocs=((kind:string,...args:unknown[])=>{const result=(list as any)(kind,...args);if(!delayed&&kind==='trigger'){delayed=true;simulated+=2000}return result}) as typeof store.listDocs
    }
    const body={items:[{id:d.externalId,summary:d.title,updated:d.updatedAt,start:{dateTime:d.occurredAt}}]}
    const api=stage==='pending-target-scan'?fakeApi([]):new HttpGoogleWorkspaceApi({accessToken:async()=> 'fixture-only',invalidate:()=>undefined},{now,apiBase:'https://example.test',fetch:async()=>new Response(JSON.stringify(body))})
    const s=scheduler({store,index,api,now,config:cfg()});const fireTimes:number[]=[]
    ;(s.runner as unknown as {opts:{fire:(t:Trigger)=>void}}).opts.fire=t=>{fireTimes.push(now());s.fired.push(t);store.putDoc('trigger',t.id,t);store.putDoc('disposition',t.id,{at:new Date(now()).toISOString(),fanout:[],context:[]})}
    await s.runner.poll(initial)
    expect(delayed).toBe(true)
    console.log(JSON.stringify({probe:stage,gateAt:initial,deadline:T0+15*MIN,fireTimes,wakes:loadConnectorWakeState(store).wakes.map(x=>({at:x.at,triggerId:x.triggerId})),pending:loadConnectorWakeState(store).pending?.map(x=>x.trigger.id)}))
    expect(fireTimes.every(at=>at<=T0+15*MIN)).toBe(true)
    expect(s.fired).toHaveLength(0)
    const state=loadConnectorWakeState(store)
    expect(state.wakes).toEqual([])
    expect(state.lastWakeAt).toBeUndefined()
    expect(state.pending).toBeUndefined()
    expect(state.notified?.some(row=>row.triggerId===p.trigger.id)).toBe(true)
    expect(store.getDoc('disposition',p.trigger.id)).toBeUndefined()
  })
  it('uses the current in-memory Calendar lookahead after durable pending admission work',async()=>{
    const {store,index}=setup();seedOwnerThread(store);seed(store,[])
    const event=draft({service:'calendar',kind:'event',externalId:'config-drift',occurredAt:new Date(T0+20*MIN).toISOString(),updatedAt:new Date(T0).toISOString(),wakeReason:'calendar event starting soon'})
    let now=T0
    const s=scheduler({store,index,api:fakeApi([event]),now:()=>now,config:cfg(30)})
    const liveConfig=(s.runner as unknown as {opts:{config:ReturnType<typeof normalizeConnectorConfig>}}).opts.config
    const put=store.putDoc.bind(store)
    store.putDoc=((kind:string,id:string,value:unknown)=>{
      const result=put(kind,id,value)
      if(kind==='connector_wake'&&(value as {pending?:unknown[]}).pending?.length)liveConfig.wake.calendarLookaheadMinutes=5
      return result
    }) as typeof store.putDoc
    commitAt(s,store,()=>now)
    await s.runner.poll(now)
    const retained=loadConnectorWakeState(store)
    expect(s.fired).toEqual([])
    expect(retained.pending).toHaveLength(1)
    expect(retained.pending?.[0]?.calendarProvenance?.occurredAt).toBe(event.occurredAt)
    expect(retained.wakes).toEqual([])
    expect(retained.notified).toEqual([])
    now=T0+16*MIN
    await s.runner.poll(now)
    expect(s.fired).toHaveLength(1)
    expect(loadConnectorWakeState(store).pending).toBeUndefined()
    expect(loadConnectorWakeState(store).lastWakeAt).toBe(now)
  })
})
