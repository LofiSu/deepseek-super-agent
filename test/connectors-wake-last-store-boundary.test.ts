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
import type { GoogleWorkspaceApi } from '../src/connectors/google.ts'
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
import type { ConnectorWakeConfig } from '../src/connectors/config.ts'

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
function liveOpts(s: ReturnType<typeof scheduler>): ConstructorParameters<typeof ConnectorWakeScheduler>[0] {
  return (s.runner as unknown as {opts: ConstructorParameters<typeof ConnectorWakeScheduler>[0]}).opts
}
function oldPrivateOwner(store:Store) {
  const original=store.getDoc<Trigger>('trigger','trg_cli_seed')!
  const owner:Trigger={...original,id:'trg_old_private_owner',source:'im',threads:[{source:'im',id:'old-private-ref'}],actor:{source:'im',id:'owner-a'},at:new Date(T0-MIN).toISOString(),channel:{source:'im',thread:'old-private-ref',address:{provider:'feishu',chat_id:'fixture-chat-a',chat_type:'p2p'}}}
  store.putDoc('trigger',owner.id,owner);store.putDoc('disposition',owner.id,{at:owner.at,fanout:[],context:[]})
  const other:Trigger={...owner,id:'trg_new_private_owner',at:new Date(T0-2*MIN).toISOString(),threads:[{source:'im',id:'new-private-ref'}],channel:{...owner.channel!,thread:'new-private-ref'}}
  store.putDoc('trigger',other.id,other);store.putDoc('disposition',other.id,{at:other.at,fanout:[],context:[]})
  return owner
}
function oldTargetConfig() {return {google:{services:['gmail']},wake:{services:['gmail'],source:'im',thread:'old-private-ref',chatId:'fixture-chat-a'}}}


type Role = 'fresh'|'pending'|'incomplete'|'uncertain'
function boundaryFixture(role:Role,id:string) {
  const {store,index,home}=setup();seedOwnerThread(store);const owner=oldPrivateOwner(store)
  const service=role==='uncertain'?'calendar':'gmail'
  const d=draft({externalId:id,service,kind:service==='calendar'?'event':'message',
    occurredAt:new Date(service==='calendar'?T0+5*MIN:T0-5*MIN).toISOString(),
    wakeReason:service==='calendar'?'calendar event starting soon':'unread important mail'})
  const record=index.upsert([d]).records[0]!
  const trigger=connectorTrigger(record,{channel:owner.channel!,actor:owner.actor},T0)
  const p:ConnectorPendingWake={at:T0,recordId:record.id,service,trigger,
    ...(service==='calendar'?{calendarProvenance:{version:1 as const,kind:'event' as const,occurredAt:record.occurredAt,updatedAt:record.updatedAt,wakeReason:record.wakeReason}}:{})}
  seed(store,role==='pending'?[p]:[],role==='incomplete'?{incomplete:[{pending:p,reason:'repaired-intake',isolatedAt:T0}]}:role==='uncertain'?{uncertain:[{pending:p,reason:'calendar-provenance-unavailable',isolatedAt:T0}]}:{})
  const config=oldTargetConfig();config.google.services=[service];config.wake.services=[service]
  const s=scheduler({store,index,api:fakeApi(role==='fresh'?[d]:[]),config,admission:{},now:()=>T0});commitAt(s,store,()=>T0)
  return {store,index,home,owner,p,s,opts:liveOpts(s)}
}
function onLastRecoveryRead(f:ReturnType<typeof boundaryFixture>,change:()=>void) {
  const get=f.store.getDoc.bind(f.store);let scanned=false,changed=false
  f.store.getDoc=((kind:string,id:string)=>{
    const v=get(kind,id)
    if(kind==='disposition'&&id===f.owner.id)scanned=true
    if(!changed&&scanned&&kind==='intake_recovery'&&id===f.p.trigger.id){changed=true;change()}
    return v
  }) as typeof f.store.getDoc
  return ()=>changed
}
describe('independent f818 last durable lifecycle read vs current normalized wake subtree',()=>{
  for(const role of ['fresh','pending','incomplete','uncertain'] as const)
  for(const gate of ['source','thread','enabled','services','chatId'] as const)
  for(const mode of ['in-place','replace-subtree'] as const)
  it(`${role}: ${mode} ${gate} revocation at last Store boundary`,async()=>{
    const f=boundaryFixture(role,`last-read-${role}-${mode}-${gate}`)
    const original=structuredClone(f.p.trigger.channel)
    const changed=onLastRecoveryRead(f,()=>{
      const patch: Partial<ConnectorWakeConfig> = gate==='source'
        ? {source:'cli',thread:'local'}
        : gate==='thread' ? {thread:'new-private-ref'}
          : gate==='enabled' ? {enabled:false}
            : gate==='services' ? {services:['docs']}
              : {chatId:'different-chat'}
      if(mode==='in-place')Object.assign(f.opts.config.wake,patch)
      else f.opts.config.wake={...f.opts.config.wake,...patch}
    })
    await f.s.runner.poll(T0)
    expect(changed()).toBe(true)
    const st=loadConnectorWakeState(f.store)
    console.log(JSON.stringify({probe:`${role}-${mode}-${gate}`,current:f.opts.config.wake,fire:f.s.fired.map(t=>({id:t.id,channel:t.channel})),wakes:st.wakes.length,notified:st.notified?.length,pending:st.pending?.length}))
    expect(f.p.trigger.channel).toEqual(original)
    expect(f.s.fired,'no old recipient fire after current policy revoked').toEqual([])
    expect(st.wakes).toEqual([]);expect(st.lastWakeAt).toBeUndefined()
    expect(f.store.getDoc('disposition',f.p.trigger.id)).toBeUndefined()
  })
})
describe('independent f818 last Store shutdown fence',()=>{
  for(const role of ['fresh','pending','incomplete','uncertain'] as const)it(`${role}: stop requested before last Store read returns`,async()=>{
    const f=boundaryFixture(role,`last-read-stop-${role}`);let stopped:Promise<void>|undefined
    const changed=onLastRecoveryRead(f,()=>{stopped=f.s.runner.stop()})
    await f.s.runner.poll(T0);await stopped
    expect(changed()).toBe(true)
    console.log(JSON.stringify({probe:`last-read-stop-${role}`,fired:f.s.fired.length,state:loadConnectorWakeState(f.store)}))
    expect(f.s.fired,'stop was requested before final current-policy/clock checks and fire invocation').toEqual([])
    expect(loadConnectorWakeState(f.store).wakes).toEqual([])
  })
})
