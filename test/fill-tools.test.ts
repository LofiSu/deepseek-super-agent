import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { Engine } from '../src/core/engine.ts'
import type { Host } from '../src/core/host.ts'
import type { FillField, FillTarget } from '../src/env/index.ts'
import { FillVault } from '../src/env/fill-vault.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import type { Ticket } from '../src/shared/types.ts'
import { loadRuntimeFillVault, Runtime } from '../src/runtime.ts'
import type { SandboxSystem } from '../src/env/seccomp.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'
import { ScriptedModel } from './scripted-model.ts'

const stores: Store[] = []
const dirs: string[] = []

function fabricate(overrides: Partial<Ticket> = {}): Ticket {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    id: 'ticket_1',
    title: 'check out with the saved card',
    brief: 'check out with the saved card',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'check out with the saved card',
      actor: { source: 'cli', id: 'you' },
      basis: 'addressed',
    },
    threadKeys: ['cli:local'],
    channels: [{ source: 'cli', thread: 'local' }],
    inputs: [{
      id: 'input_1',
      kind: 'trigger',
      triggerId: 'trg_1',
      text: 'check out with the saved card',
      at,
      human: true,
    }],
    assignments: [{ id: 'asg_1', state: 'running', speculative: false, startedAt: at }],
    speculative: false,
    originTriggerId: 'trg_1',
    createdAt: at,
    ...overrides,
  }
}

class RecordingTarget implements FillTarget {
  readonly label = 'browser:checkout.example'
  readonly writes: { field: string; value: string }[] = []

  fill(field: FillField, value: string): void {
    this.writes.push({ field, value })
  }
}

class UncertainTarget extends RecordingTarget {
  calls = 0
  override fill(field: FillField, value: string): void {
    super.fill(field, value)
    this.calls += 1
    if (this.calls === 1) throw new Error('simulated lost response after external write')
  }
}

class BlockingTarget extends RecordingTarget {
  started!: () => void
  release!: () => void
  readonly startedPromise = new Promise<void>(resolve => { this.started = resolve })
  private readonly blocked = new Promise<void>(resolve => { this.release = resolve })

  override async fill(field: FillField, value: string): Promise<void> {
    this.started()
    await this.blocked
    super.fill(field, value)
  }
}

function buildTools(store: Store, home: string, vault: FillVault, target: FillTarget, logs: string[]) {
  const host: Host = {
    repo: store,
    now: () => new Date().toISOString(),
    metrics: new Metrics(home),
    log: line => logs.push(line),
    scope: { admit: () => ({ listened: true, reason: 'test' }) },
  }
  return new ToolRegistry({
    store,
    ports: bindRolePorts(new Engine(host)),
    env: new LocalEnv(path.join(home, 'workspaces'), { sandbox: { enabled: false } }),
    metrics: new Metrics(home),
    redact: text => text,
    log: line => logs.push(line),
    scheduleJob: () => {},
    routerTurn: async () => {},
    fill: { vault, target },
  })
}

function open(opts: { target?: FillTarget } = {}) {
  const home = tempHome()
  dirs.push(home)
  const store = new Store(home)
  stores.push(store)
  const logs: string[] = []
  const host: Host = {
    repo: store,
    now: () => new Date().toISOString(),
    metrics: new Metrics(home),
    log: line => logs.push(line),
    scope: { admit: () => ({ listened: true, reason: 'test' }) },
  }
  const engine = new Engine(host)
  const vault = FillVault.fromDocument({
    fill: {
      login: { kind: 'password', username: 'owner@example.com', password: 'vault-password-sentinel' },
      visa: { kind: 'card', number: '4111111111111111', expiry: '12/29', cvc: '987' },
    },
  })
  const fill = opts.target
    ? { vault, target: opts.target }
    : { vault }
  const tools = new ToolRegistry({
    store,
    ports: bindRolePorts(engine),
    env: new LocalEnv(path.join(home, 'workspaces'), { sandbox: { enabled: false } }),
    metrics: new Metrics(home),
    redact: text => text,
    log: line => logs.push(line),
    scheduleJob: () => {},
    routerTurn: async () => {},
    fill,
  })
  store.putDoc('ticket', 'ticket_1', fabricate())
  return { store, engine, tools, vault, logs, home }
}

afterEach(() => {
  for (const store of stores.splice(0)) if (store.isOpen) store.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const ctx = { sessionId: 'worker_ticket_1', role: 'worker' as const, ticketId: 'ticket_1' }

describe('fill vault tools', () => {
  it('lists entries without values and is worker-only', async () => {
    const { tools } = open({ target: new RecordingTarget() })
    const result = await tools.invoke({ id: 'c1', name: 'list_vault_entries', args: {} }, ctx) as {
      entries: { name: string }[]
      target: string
    }
    expect(result.target).toBe('browser:checkout.example')
    expect(result.entries.map(entry => entry.name)).toEqual(['login', 'visa'])
    expect(JSON.stringify(result)).not.toContain('vault-password-sentinel')
    expect(JSON.stringify(result)).not.toContain('4111111111111111')
    expect((await tools.specsFor('router')).map(spec => spec.name))
      .not.toContain('fill_credential')
    expect((await tools.specsFor('watchdog')).map(spec => spec.name))
      .not.toContain('prepare_fill')
  })

  it('plans the exact action, requires approval for it, then fills without returning a value', async () => {
    const target = new RecordingTarget()
    const { tools, engine, store, logs } = open({ target })

    const plan = await tools.invoke(
      { id: 'c2', name: 'prepare_fill', args: { entry: 'visa', fields: 'number,expiry' } },
      ctx,
    ) as { action: string; actionId: string; fields: string[]; target: string }
    expect(plan.action).toBe('Fill card "visa" into form "browser:checkout.example" (number, expiry)')
    expect(plan.actionId).toMatch(/^act_[0-9a-f]{16}$/)
    expect(JSON.stringify(plan)).not.toContain('4111111111111111')

    // Not approved yet: the fill is refused and the target is untouched.
    await expect(tools.invoke(
      { id: 'c3', name: 'fill_credential', args: { entry: 'visa', fields: 'number,expiry', approvalId: 'appr_missing' } },
      ctx,
    )).rejects.toThrow(/unknown approval/)
    expect(target.writes).toHaveLength(0)

    const requested = await tools.invoke(
      { id: 'c4', name: 'request_approval', args: { action: plan.action, reason: 'checkout' } },
      ctx,
    ) as { approvalId: string; actionId: string }
    expect(requested.actionId).toBe(plan.actionId)

    const pending = store.getDoc<Ticket>('ticket', 'ticket_1')!.collab!.approvals![0]!
    await expect(tools.invoke(
      { id: 'c5', name: 'fill_credential', args: { entry: 'visa', fields: 'number,expiry', approvalId: pending.id } },
      ctx,
    )).rejects.toThrow(/owner approval is required/)

    engine.decideApproval('ticket_1', pending.id, 'approved')
    const receipt = await tools.invoke(
      { id: 'c6', name: 'fill_credential', args: { entry: 'visa', fields: 'number,expiry', approvalId: pending.id } },
      ctx,
    ) as { entry: string; fields: string[]; target: string; actionId: string }

    expect(receipt).toMatchObject({
      entry: 'visa',
      fields: ['number', 'expiry'],
      target: 'browser:checkout.example',
      actionId: plan.actionId,
    })
    expect(target.writes).toEqual([
      { field: 'number', value: '4111111111111111' },
      { field: 'expiry', value: '12/29' },
    ])
    const visible = JSON.stringify(receipt) + logs.join('\n')
    expect(visible).not.toContain('4111111111111111')
    expect(visible).not.toContain('12/29')
    expect(store.getDoc<Ticket>('ticket', 'ticket_1')!.collab!.approvals![0]!.usedAt).toBeTruthy()

    // One approved card authorizes one fill, not an unbounded replay.
    await expect(tools.invoke(
      { id: 'c6b', name: 'fill_credential', args: { entry: 'visa', fields: 'number,expiry', approvalId: pending.id } },
      ctx,
    )).rejects.toThrow(/already used for a fill/)
    expect(target.writes).toHaveLength(2)
  })

  it('consumes approval before an uncertain target effect and preserves that state across restart', async () => {
    const target = new UncertainTarget()
    const { tools, engine, store, vault, logs, home } = open({ target })
    const plan = await tools.invoke(
      { id: 'uncertain-plan', name: 'prepare_fill', args: { entry: 'visa', fields: 'number' } },
      ctx,
    ) as { action: string }
    const requested = await tools.invoke(
      { id: 'uncertain-approval', name: 'request_approval', args: { action: plan.action } },
      ctx,
    ) as { approvalId: string }
    engine.decideApproval('ticket_1', requested.approvalId, 'approved')
    const call = {
      id: 'uncertain-fill',
      name: 'fill_credential',
      args: { entry: 'visa', fields: 'number', approvalId: requested.approvalId },
    }

    await expect(tools.invoke(call, ctx)).rejects.toThrow(/simulated lost response/)
    expect(target.calls).toBe(1)
    expect(target.writes).toHaveLength(1)
    expect(store.getDoc<Ticket>('ticket', 'ticket_1')!.collab!.approvals![0]!.fillState).toBe('unknown')
    await expect(tools.invoke({ ...call, id: 'uncertain-replay' }, ctx)).rejects.toThrow(/unknown fill outcome/)
    expect(target.calls).toBe(1)

    store.close()
    const restartedStore = new Store(home)
    stores.push(restartedStore)
    const restartedTools = buildTools(restartedStore, home, vault, target, logs)
    await expect(restartedTools.invoke({ ...call, id: 'uncertain-after-restart' }, ctx))
      .rejects.toThrow(/unknown fill outcome/)
    expect(target.calls).toBe(1)
  })

  it('blocks concurrent calls while the durable approval claim is in flight', async () => {
    const target = new BlockingTarget()
    const { tools, engine, store } = open({ target })
    const plan = await tools.invoke(
      { id: 'concurrent-plan', name: 'prepare_fill', args: { entry: 'visa', fields: 'number' } },
      ctx,
    ) as { action: string }
    const requested = await tools.invoke(
      { id: 'concurrent-approval', name: 'request_approval', args: { action: plan.action } },
      ctx,
    ) as { approvalId: string }
    engine.decideApproval('ticket_1', requested.approvalId, 'approved')
    const call = {
      name: 'fill_credential',
      args: { entry: 'visa', fields: 'number', approvalId: requested.approvalId },
    }
    const first = tools.invoke({ ...call, id: 'concurrent-first' }, ctx)
    await target.startedPromise
    await expect(tools.invoke({ ...call, id: 'concurrent-second' }, ctx)).rejects.toThrow(/in_flight fill outcome/)
    target.release()
    await expect(first).resolves.toMatchObject({ entry: 'visa', fields: ['number'] })
    expect(target.writes).toHaveLength(1)
    expect(store.getDoc<Ticket>('ticket', 'ticket_1')!.collab!.approvals![0]!.fillState).toBe('completed')
  })

  it('rejects an approval whose exact action text is for another fill', async () => {
    const target = new RecordingTarget()
    const { tools, engine, store } = open({ target })
    const requested = await tools.invoke(
      { id: 'c7', name: 'request_approval', args: { action: 'Fill card "visa" into form "browser:checkout.example" (number)' } },
      ctx,
    ) as { approvalId: string }
    engine.decideApproval('ticket_1', requested.approvalId, 'approved')

    await expect(tools.invoke(
      { id: 'c8', name: 'fill_credential', args: { entry: 'visa', fields: 'number,expiry', approvalId: requested.approvalId } },
      ctx,
    )).rejects.toThrow(/does not match this fill/)
    expect(target.writes).toHaveLength(0)
    expect(store.getDoc<Ticket>('ticket', 'ticket_1')!.collab!.approvals![0]!.status).toBe('approved')
  })

  it('refuses a denied or dismissed card', async () => {
    const target = new RecordingTarget()
    const { tools, engine } = open({ target })
    const plan = await tools.invoke(
      { id: 'c9', name: 'prepare_fill', args: { entry: 'login' } },
      ctx,
    ) as { action: string }
    const requested = await tools.invoke(
      { id: 'c10', name: 'request_approval', args: { action: plan.action } },
      ctx,
    ) as { approvalId: string }
    engine.decideApproval('ticket_1', requested.approvalId, 'dismissed')

    await expect(tools.invoke(
      { id: 'c11', name: 'fill_credential', args: { entry: 'login', approvalId: requested.approvalId } },
      ctx,
    )).rejects.toThrow(/is dismissed/)
    expect(target.writes).toHaveLength(0)
  })

  it('cannot fill without a configured target and cannot read a value back', async () => {
    const { tools, vault } = open()
    await expect(tools.invoke(
      { id: 'c12', name: 'prepare_fill', args: { entry: 'login' } },
      ctx,
    )).rejects.toThrow(/no fill target is configured/)
    expect(vault.summary()).toEqual([
      { name: 'login', kind: 'password', fields: ['username', 'password'] },
      { name: 'visa', kind: 'card', fields: ['number', 'expiry', 'cvc'] },
    ])
    const specs = await tools.specsFor('worker')
    expect(specs.map(spec => spec.name)).not.toContain('read_vault_entry')
    expect(specs.map(spec => spec.name)).not.toContain('get_credential')
  })

  it('Runtime disables file-backed vaults visible through workspace, system, or symlink roots', () => {
    const home = tempHome()
    dirs.push(home)
    const document = JSON.stringify({ fill: { login: { kind: 'password', password: 'SYNTHETIC-GATE-SECRET' } } })
    const writeSyntheticVault = (directory: string, name = 'vault.json') => {
      fs.mkdirSync(directory, { recursive: true })
      const file = path.join(directory, name)
      fs.writeFileSync(file, document, { mode: 0o600 })
      fs.chmodSync(file, 0o600)
      return file
    }
    const system: SandboxSystem = {
      platform: 'linux',
      available: () => true,
      exists: () => false,
    }

    const workspaceRoot = path.join(home, 'workspaces')
    const workspaceVault = writeSyntheticVault(workspaceRoot)
    const workspaceResult = loadRuntimeFillVault(workspaceVault, {
      enabled: true,
      readIsolation: true,
      writableRoots: [workspaceRoot],
    }, system)
    expect(workspaceResult).toEqual({ reason: 'worker-readable-location' })

    const exposedRoot = path.join(home, 'synthetic-system-root')
    const exposedVault = writeSyntheticVault(exposedRoot)
    const systemResult = loadRuntimeFillVault(exposedVault, {
      enabled: true,
      readIsolation: true,
      readRoots: [exposedRoot],
    }, system)
    expect(systemResult).toEqual({ reason: 'worker-readable-location' })

    const linkTargetRoot = path.join(home, 'synthetic-readable-root')
    const linkTarget = writeSyntheticVault(linkTargetRoot)
    const linkPath = path.join(home, 'vault-link.json')
    fs.symlinkSync(linkTarget, linkPath)
    const symlinkResult = loadRuntimeFillVault(linkPath, {
      enabled: true,
      readIsolation: true,
      readRoots: [linkTargetRoot],
    }, system)
    expect(symlinkResult).toEqual({ reason: 'worker-readable-location' })
  })

  it('loads an owner-only vault file into the Runtime and never logs a value', () => {
    const home = tempHome()
    dirs.push(home)
    const file = path.join(home, 'vault.json')
    fs.writeFileSync(file, JSON.stringify({
      fill: { login: { kind: 'password', password: 'runtime-vault-sentinel' } },
    }), { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    const runtime = Runtime.create({
      home,
      model: new ScriptedModel(() => ({ text: 'ok' })),
      fillTarget: new RecordingTarget(),
      env: { PATH: process.env.PATH },
    })
    try {
      const logs = runtime.log.text()
      expect(logs).toContain('[fill] vault=entries=1 target=browser:checkout.example')
      expect(logs).not.toContain('runtime-vault-sentinel')
    } finally {
      runtime.store.close()
    }
  })

  it('does not register fill tools when the vault config is absent', async () => {
    const home = tempHome()
    dirs.push(home)
    const store = new Store(home)
    stores.push(store)
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      metrics: new Metrics(home),
      log: () => {},
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const tools = new ToolRegistry({
      store,
      ports: bindRolePorts(new Engine(host)),
      env: new LocalEnv(path.join(home, 'workspaces'), { sandbox: { enabled: false } }),
      metrics: new Metrics(home),
      redact: text => text,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    const names = (await tools.specsFor('worker')).map(spec => spec.name)
    expect(names).not.toContain('list_vault_entries')
    expect(names).not.toContain('prepare_fill')
    expect(names).not.toContain('fill_credential')
  })
})
