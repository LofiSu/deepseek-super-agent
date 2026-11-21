import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { FeaturePrPublisher } from '../src/env/git-publish.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import type { PublishApprovalBinding } from '../src/shared/types.ts'
import { UserError } from '../src/shared/errors.ts'
import type { Runtime } from '../src/runtime.ts'
import { Store } from '../src/store/sqlite.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

const binding: PublishApprovalBinding = {
  repo: 'o/r',
  head: 'a'.repeat(40),
  branch: 'peanut/feature',
  base: 'main',
  title: 'Approved title',
  body: 'Approved body',
}

function registry(runtime: Runtime, publisher?: FeaturePrPublisher, store: Store = runtime.store): ToolRegistry {
  return new ToolRegistry({
    store,
    ports: bindRolePorts(runtime.engine),
    env: new LocalEnv(path.join(runtime.home, 'workspaces')),
    metrics: runtime.metrics,
    redact: s => s,
    log: () => {},
    scheduleJob: () => {},
    routerTurn: async () => {},
    publishFeaturePr: publisher,
  })
}

function seedTicket(runtime: Runtime, ticketId: string): void {
  runtime.store.putDoc('ticket', ticketId, {
    id: ticketId,
    title: 'publish feature',
    brief: 'publish feature',
    speculative: false,
    assignments: [],
    threadKeys: [],
    channels: [],
    inputs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never)
}

describe('publish_feature_pr tool', () => {
  let runtime: Runtime | undefined

  afterEach(async () => {
    if (runtime) await shutdown(runtime)
    runtime = undefined
  })

  it('is unavailable without publisher', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    const tools = registry(runtime)
    await expect(
      tools.invoke(
        { id: 'c1', name: 'publish_feature_pr', args: { title: 't', approvalId: 'a1' } },
        { sessionId: 'w1', role: 'worker', ticketId: 'ticket-1' },
      ),
    ).rejects.toThrow(UserError)
  })

  it('refuses publishing without an owner approval before publisher or gh calls', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    const pub = {
      prepare: vi.fn(async () => binding),
      publish: vi.fn(async () => ({ url: 'x', number: 1, branch: binding.branch, remote: binding.repo })),
    } as unknown as FeaturePrPublisher
    const tools = registry(runtime, pub)
    await expect(tools.invoke(
      { id: 'c1', name: 'publish_feature_pr', args: { approvalId: 'missing', title: binding.title, body: binding.body, branch: binding.branch } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-approval' },
    )).rejects.toThrow(/owner-approved publish request/)
    expect(pub.prepare).not.toHaveBeenCalled()
    expect(pub.publish).not.toHaveBeenCalled()
  })

  it('does not publish while the bound owner approval is pending', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    seedTicket(runtime, 'ticket-approval')
    const request = runtime.engine.requestApproval('ticket-approval', {
      action: `publish_feature_pr ${JSON.stringify(binding)}`,
      requestedBy: 'w1',
      publish: binding,
    })
    const pub = {
      prepare: vi.fn(async () => binding),
      publish: vi.fn(async () => ({ url: 'x', number: 1, branch: binding.branch, remote: binding.repo })),
    } as unknown as FeaturePrPublisher
    const tools = registry(runtime, pub)
    await expect(tools.invoke(
      { id: 'c1', name: 'publish_feature_pr', args: {
        approvalId: request.approval.id,
        title: binding.title,
        body: binding.body,
        branch: binding.branch,
      } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-approval' },
    )).rejects.toThrow(/owner-approved publish request/)
    expect(pub.prepare).not.toHaveBeenCalled()
    expect(pub.publish).not.toHaveBeenCalled()
  })

  it('records exact host-computed publish metadata in the pending owner approval', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    seedTicket(runtime, 'ticket-approval')
    const pub = {
      prepare: vi.fn(async () => binding),
      publish: vi.fn(),
    } as unknown as FeaturePrPublisher
    const tools = registry(runtime, pub)
    const result = await tools.invoke(
      { id: 'c1', name: 'request_approval', args: { publish: {
        title: binding.title,
        body: binding.body,
        branch: binding.branch,
      } } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-approval' },
    ) as { approvalId: string; status: string }
    const saved = runtime.store.getDoc<{ collab?: { approvals?: Array<{ id: string; status: string; publish?: PublishApprovalBinding }> } }>('ticket', 'ticket-approval')
    expect(result.status).toBe('pending')
    expect(saved?.collab?.approvals?.find(item => item.id === result.approvalId)).toMatchObject({
      status: 'pending',
      publish: binding,
    })
    expect(pub.publish).not.toHaveBeenCalled()
  })

  it('refuses an approved publish after its ticket has ended', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    seedTicket(runtime, 'ticket-ended')
    const request = runtime.engine.requestApproval('ticket-ended', {
      action: `publish_feature_pr ${JSON.stringify(binding)}`,
      requestedBy: 'w1',
      publish: binding,
    })
    runtime.engine.decideApproval('ticket-ended', request.approval.id, 'approved')
    const ticket = runtime.store.getDoc<{ ended?: { at: string; outcome: string; by: 'human' } }>('ticket', 'ticket-ended')!
    ticket.ended = { at: new Date().toISOString(), outcome: 'stopped', by: 'human' }
    runtime.store.putDoc('ticket', 'ticket-ended', ticket)
    const pub = {
      prepare: vi.fn(async () => binding),
      publish: vi.fn(async () => ({ url: 'x', number: 1, branch: binding.branch, remote: binding.repo })),
    } as unknown as FeaturePrPublisher
    const tools = registry(runtime, pub)

    await expect(tools.invoke(
      { id: 'c1', name: 'publish_feature_pr', args: {
        approvalId: request.approval.id,
        title: binding.title,
        body: binding.body,
        branch: binding.branch,
      } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-ended' },
    )).rejects.toThrow(/ticket .* has ended/)
    expect(pub.prepare).not.toHaveBeenCalled()
    expect(pub.publish).not.toHaveBeenCalled()
  })

  it('rechecks ticket lifecycle after asynchronous approval preparation', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    seedTicket(runtime, 'ticket-ending-during-prepare')
    const request = runtime.engine.requestApproval('ticket-ending-during-prepare', {
      action: `publish_feature_pr ${JSON.stringify(binding)}`,
      requestedBy: 'w1',
      publish: binding,
    })
    runtime.engine.decideApproval('ticket-ending-during-prepare', request.approval.id, 'approved')
    const pub = {
      prepare: vi.fn(async () => {
        const current = runtime!.store.getDoc<{ ended?: { at: string; outcome: string; by: 'human' } }>(
          'ticket',
          'ticket-ending-during-prepare',
        )!
        current.ended = { at: new Date().toISOString(), outcome: 'stopped', by: 'human' }
        runtime!.store.putDoc('ticket', 'ticket-ending-during-prepare', current)
        return binding
      }),
      publish: vi.fn(async () => ({ url: 'x', number: 1, branch: binding.branch, remote: binding.repo })),
    } as unknown as FeaturePrPublisher
    const tools = registry(runtime, pub)

    await expect(tools.invoke(
      { id: 'c1', name: 'publish_feature_pr', args: {
        approvalId: request.approval.id,
        title: binding.title,
        body: binding.body,
        branch: binding.branch,
      } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-ending-during-prepare' },
    )).rejects.toThrow(/ticket .* has ended/)
    expect(pub.prepare).toHaveBeenCalledOnce()
    expect(pub.publish).not.toHaveBeenCalled()
  })

  it('consumes one approved publish request after its first publication', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    seedTicket(runtime, 'ticket-single-use')
    const request = runtime.engine.requestApproval('ticket-single-use', {
      action: `publish_feature_pr ${JSON.stringify(binding)}`,
      requestedBy: 'w1',
      publish: binding,
    })
    runtime.engine.decideApproval('ticket-single-use', request.approval.id, 'approved')
    const pub = {
      prepare: vi.fn(async () => binding),
      publish: vi.fn(async () => ({ url: 'x', number: 1, branch: binding.branch, remote: binding.repo })),
    } as unknown as FeaturePrPublisher
    const tools = registry(runtime, pub)
    const call = () => tools.invoke(
      { id: 'c1', name: 'publish_feature_pr', args: {
        approvalId: request.approval.id,
        title: binding.title,
        body: binding.body,
        branch: binding.branch,
      } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-single-use' },
    )

    await expect(call()).resolves.toMatchObject({ number: 1 })
    expect(runtime.store.listPublishAdmissions('ticket-single-use')[0]).toMatchObject({
      approvalId: request.approval.id,
      binding,
      observationState: 'returned',
      result: { number: 1, branch: binding.branch, remote: binding.repo },
    })
    const reopened = new Store(runtime.home)
    try {
      await expect(registry(runtime, pub, reopened).invoke(
        { id: 'c2', name: 'publish_feature_pr', args: {
          approvalId: request.approval.id,
          title: binding.title,
          body: binding.body,
          branch: binding.branch,
        } },
        { sessionId: 'w1', role: 'worker', ticketId: 'ticket-single-use' },
      )).rejects.toThrow(/already been used/)
    } finally {
      reopened.close()
    }
    expect(pub.publish).toHaveBeenCalledOnce()
  })

  it('admits only one of two overlapping calls on separate SQLite connections', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    seedTicket(runtime, 'ticket-overlapping')
    const request = runtime.engine.requestApproval('ticket-overlapping', {
      action: `publish_feature_pr ${JSON.stringify(binding)}`,
      requestedBy: 'w1',
      publish: binding,
    })
    runtime.engine.decideApproval('ticket-overlapping', request.approval.id, 'approved')

    let readyCount = 0
    let release!: () => void
    const bothPrepared = new Promise<void>(resolve => { release = resolve })
    const publisher = () => ({
      prepare: vi.fn(async () => {
        readyCount += 1
        if (readyCount === 2) release()
        await bothPrepared
        return binding
      }),
      publish: vi.fn(async () => ({ url: 'x', number: 1, branch: binding.branch, remote: binding.repo })),
    })
    const firstPublisher = publisher()
    const secondPublisher = publisher()
    const secondStore = new Store(runtime.home)
    try {
      const calls = [
        registry(runtime, firstPublisher as unknown as FeaturePrPublisher).invoke(
          { id: 'c1', name: 'publish_feature_pr', args: {
            approvalId: request.approval.id,
            title: binding.title,
            body: binding.body,
            branch: binding.branch,
          } },
          { sessionId: 'w1', role: 'worker', ticketId: 'ticket-overlapping' },
        ),
        registry(runtime, secondPublisher as unknown as FeaturePrPublisher, secondStore).invoke(
          { id: 'c2', name: 'publish_feature_pr', args: {
            approvalId: request.approval.id,
            title: binding.title,
            body: binding.body,
            branch: binding.branch,
          } },
          { sessionId: 'w1', role: 'worker', ticketId: 'ticket-overlapping' },
        ),
      ]
      const results = await Promise.allSettled(calls)
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect(firstPublisher.publish.mock.calls.length + secondPublisher.publish.mock.calls.length).toBe(1)
    } finally {
      secondStore.close()
    }
  })

  it('does not replay approval after local push succeeds but confirmation fails', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    seedTicket(runtime, 'ticket-uncertain')
    const ws = path.join(runtime.home, 'workspaces', 'w1')
    const bare = path.join(runtime.home, 'uncertain-local-remote.git')
    fs.mkdirSync(ws, { recursive: true })
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore', env: gitEnv })
    execFileSync('git', ['init', '-b', 'main'], { cwd: ws, stdio: 'ignore', env: gitEnv })
    execFileSync('git', ['config', 'user.email', 'fixture@invalid'], { cwd: ws, env: gitEnv })
    execFileSync('git', ['config', 'user.name', 'Owned Fixture'], { cwd: ws, env: gitEnv })
    fs.writeFileSync(path.join(ws, 'README.md'), 'owned uncertainty fixture\n')
    execFileSync('git', ['add', 'README.md'], { cwd: ws, env: gitEnv })
    execFileSync('git', ['commit', '-m', 'owned fixture'], { cwd: ws, stdio: 'ignore', env: gitEnv })
    execFileSync('git', ['checkout', '-b', 'peanut/uncertain'], { cwd: ws, stdio: 'ignore', env: gitEnv })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8', env: gitEnv }).trim()
    const approved: PublishApprovalBinding = { ...binding, head, branch: 'peanut/uncertain' }
    const request = runtime.engine.requestApproval('ticket-uncertain', {
      action: `publish_feature_pr ${JSON.stringify(approved)}`,
      requestedBy: 'w1',
      publish: approved,
    })
    runtime.engine.decideApproval('ticket-uncertain', request.approval.id, 'approved')
    const pub = {
      prepare: vi.fn(async () => approved),
      publish: vi.fn(async (_input: unknown, authorized: PublishApprovalBinding) => {
        execFileSync('git', ['push', bare, `${authorized.head}:refs/heads/${authorized.branch}`], {
          cwd: ws,
          stdio: 'ignore',
          env: gitEnv,
        })
        throw new Error('local push succeeded; confirmation interrupted')
      }),
    }
    const tools = registry(runtime, pub as unknown as FeaturePrPublisher)
    const input = { approvalId: request.approval.id, title: approved.title, body: approved.body, branch: approved.branch }
    const ctx = { sessionId: 'w1', role: 'worker' as const, ticketId: 'ticket-uncertain' }

    await expect(tools.invoke({ id: 'c1', name: 'publish_feature_pr', args: input }, ctx))
      .rejects.toThrow('local push succeeded; confirmation interrupted')
    const persisted = runtime.store.listPublishAdmissions('ticket-uncertain')[0]
    expect(persisted).toMatchObject({ binding: approved, observationState: 'unconfirmed' })
    expect(JSON.stringify(persisted)).not.toContain('confirmation interrupted')
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', `refs/heads/${approved.branch}`], {
      encoding: 'utf8', env: gitEnv,
    }).trim()).toBe(head)
    await expect(tools.invoke({ id: 'c2', name: 'publish_feature_pr', args: input }, ctx))
      .rejects.toThrow(/already been used/)
    expect(pub.publish).toHaveBeenCalledOnce()
  })

  it('keeps admission consumed when the process stops before publisher entry', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    seedTicket(runtime, 'ticket-stopped-before-publisher')
    const request = runtime.engine.requestApproval('ticket-stopped-before-publisher', {
      action: `publish_feature_pr ${JSON.stringify(binding)}`,
      requestedBy: 'w1',
      publish: binding,
    })
    runtime.engine.decideApproval('ticket-stopped-before-publisher', request.approval.id, 'approved')
    const publisher = {
      prepare: vi.fn(async () => binding),
      publish: vi.fn(async () => ({ url: 'x', number: 1, branch: binding.branch, remote: binding.repo })),
    }
    const tools = registry(runtime, publisher as unknown as FeaturePrPublisher)
    const call = () => tools.invoke(
      { id: 'c1', name: 'publish_feature_pr', args: {
        approvalId: request.approval.id, title: binding.title, body: binding.body, branch: binding.branch,
      } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-stopped-before-publisher' },
    )
    const marker = vi.spyOn(runtime.store, 'markPublishAttemptStarted').mockImplementation(() => {
      throw new Error('simulated stop before publisher entry')
    })
    await expect(call()).rejects.toThrow('simulated stop before publisher entry')
    marker.mockRestore()
    expect(publisher.publish).not.toHaveBeenCalled()
    expect(runtime.store.listPublishAdmissions('ticket-stopped-before-publisher')[0])
      .toMatchObject({ binding, observationState: 'admitted' })
    await expect(call()).rejects.toThrow(/already been used/)
    expect(publisher.publish).not.toHaveBeenCalled()
  })

  it('leaves an unconfirmed publisher boundary when result persistence fails', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    seedTicket(runtime, 'ticket-confirmation-write-fails')
    const request = runtime.engine.requestApproval('ticket-confirmation-write-fails', {
      action: `publish_feature_pr ${JSON.stringify(binding)}`,
      requestedBy: 'w1',
      publish: binding,
    })
    runtime.engine.decideApproval('ticket-confirmation-write-fails', request.approval.id, 'approved')
    let externalEffect = 0
    const publisher = {
      prepare: vi.fn(async () => binding),
      publish: vi.fn(async () => {
        externalEffect += 1
        return { url: 'https://github.invalid/o/r/pull/8', number: 8, branch: binding.branch, remote: binding.repo }
      }),
    }
    const tools = registry(runtime, publisher as unknown as FeaturePrPublisher)
    const persist = vi.spyOn(runtime.store, 'recordPublishReturned').mockImplementation(() => {
      throw new Error('simulated local confirmation write failure')
    })
    await expect(tools.invoke(
      { id: 'c1', name: 'publish_feature_pr', args: {
        approvalId: request.approval.id, title: binding.title, body: binding.body, branch: binding.branch,
      } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-confirmation-write-fails' },
    )).rejects.toThrow('simulated local confirmation write failure')
    persist.mockRestore()
    expect(externalEffect).toBe(1)
    expect(runtime.store.listPublishAdmissions('ticket-confirmation-write-fails')[0])
      .toMatchObject({ binding, observationState: 'attempt_started' })
    await expect(tools.invoke(
      { id: 'c2', name: 'publish_feature_pr', args: {
        approvalId: request.approval.id, title: binding.title, body: binding.body, branch: binding.branch,
      } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-confirmation-write-fails' },
    )).rejects.toThrow(/already been used/)
    expect(publisher.publish).toHaveBeenCalledOnce()
  })

  it('refuses an approved request bound to different metadata', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    seedTicket(runtime, 'ticket-approval')
    const request = runtime.engine.requestApproval('ticket-approval', {
      action: `publish_feature_pr ${JSON.stringify(binding)}`,
      requestedBy: 'w1',
      publish: binding,
    })
    runtime.engine.decideApproval('ticket-approval', request.approval.id, 'approved')
    const pub = {
      prepare: vi.fn(async () => ({ ...binding, head: 'b'.repeat(40) })),
      publish: vi.fn(async () => ({ url: 'x', number: 1, branch: binding.branch, remote: binding.repo })),
    }
    const tools = registry(runtime, pub as unknown as FeaturePrPublisher)
    await expect(tools.invoke(
      { id: 'c1', name: 'publish_feature_pr', args: {
        approvalId: request.approval.id,
        title: binding.title,
        body: binding.body,
        branch: binding.branch,
      } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-approval' },
    )).rejects.toThrow(/does not match/)
    expect(pub.publish).not.toHaveBeenCalled()
    pub.prepare.mockResolvedValue(binding)
    await expect(tools.invoke(
      { id: 'c2', name: 'publish_feature_pr', args: {
        approvalId: request.approval.id,
        title: binding.title,
        body: binding.body,
        branch: binding.branch,
      } },
      { sessionId: 'w1', role: 'worker', ticketId: 'ticket-approval' },
    )).resolves.toMatchObject({ number: 1 })
    expect(pub.publish).toHaveBeenCalledOnce()
  })

  it('is not exposed to router or watchdog', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    const pub = new FeaturePrPublisher({
      repo: { owner: 'o', repo: 'r', full: 'o/r' },
      workspace: workerId => path.join(runtime!.home, 'workspaces', workerId),
    })
    const tools = registry(runtime, pub)
    expect((await tools.specsFor('router')).some(s => s.name === 'publish_feature_pr')).toBe(false)
    expect((await tools.specsFor('watchdog')).some(s => s.name === 'publish_feature_pr')).toBe(false)
    expect((await tools.specsFor('worker')).some(s => s.name === 'publish_feature_pr')).toBe(true)
  })
})
