import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { FeaturePrPublisher } from '../src/env/git-publish.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import type { PublishApprovalBinding } from '../src/shared/types.ts'
import { UserError } from '../src/shared/errors.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

const binding: PublishApprovalBinding = {
  repo: 'o/r',
  head: 'a'.repeat(40),
  branch: 'peanut/feature',
  base: 'main',
  title: 'Approved title',
  body: 'Approved body',
}

function registry(runtime: Runtime, publisher?: FeaturePrPublisher): ToolRegistry {
  return new ToolRegistry({
    store: runtime.store,
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
    )).rejects.toThrow(/does not match/)
    expect(pub.publish).not.toHaveBeenCalled()
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
