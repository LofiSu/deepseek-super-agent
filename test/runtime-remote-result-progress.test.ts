import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Ticket } from '../src/shared/types.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { silentModel } from './scripted-model.ts'

const HOST = 'progress-host'
const NODE_A = 'remote-a'
const PEER_A = 'worker-a'
const SECRET = 'remote-result-progress-secret-0123456789abcdef'
const RESULT_TIMEOUT_MS = 120

const runtimes: Runtime[] = []
const homes: string[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function progressRuntime(): Runtime {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-progress-'))
  homes.push(home)
  const runtime = freshRuntime({
    home,
    meshCapacity: 2,
    instanceId: HOST,
    singleSession: true,
    jobDelayMs: 0,
    remoteResultTimeoutMs: RESULT_TIMEOUT_MS,
    env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1', DS_AGENT_INSTANCE_ID: HOST },
    model: silentModel(),
  })
  runtime.placement.registerRemoteNode({
    id: NODE_A,
    url: 'http://127.0.0.1:9/a2a',
    peerId: PEER_A,
    secret: SECRET,
    capacity: 1,
  })
  runtime.start({ assessPending: false })
  runtimes.push(runtime)
  return runtime
}

function placedTicket(runtime: Runtime, slug: string): { ticketId: string; assignmentId: string } {
  runtime.engine.receive(
    imTrigger({ id: `trg_${slug}`, thread: `topic/${slug}`, text: '@ds-agent fix checkout' }),
    { shards: ['default'] },
  )
  const ticketId = runtime.engine.evaluateDue()[0]?.ticketId ?? ''
  if (!ticketId) throw new Error('expected ticket')
  const assignmentId = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments.at(-1)!.id
  runtime.engine.assignmentStarted(ticketId, assignmentId, `sess-${slug}`)
  runtime.engine.assignmentPlaced(ticketId, assignmentId, NODE_A)
  const node = runtime.placement.remote!.pick(ticketId)
  if (!node || node.id !== NODE_A) throw new Error('expected remote placement')
  return { ticketId, assignmentId }
}

function armWait(runtime: Runtime, ticketId: string, assignmentId: string): void {
  const wait = (runtime as unknown as {
    remoteResultWait?: { arm(ticketId: string, assignmentId: string): void }
  }).remoteResultWait
  wait?.arm(ticketId, assignmentId)
}

async function waitFor(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (!predicate()) throw new Error(`timed out waiting for ${label}`)
}

describe('Runtime remote progress result', () => {
  it('keeps the mesh slot and result wait after a non-ending progress report', async () => {
    const runtime = progressRuntime()
    const { ticketId, assignmentId } = placedTicket(runtime, 'progress_keep')
    armWait(runtime, ticketId, assignmentId)

    expect(runtime.placement.remoteHasTicket(ticketId)).toBe(true)

    runtime.applyRemoteAssignmentResult({
      peerId: PEER_A,
      ticketId,
      assignmentId,
      report: { kind: 'progress', text: 'still working remotely', deliver: false },
      deliveryKey: `deliv-progress-${ticketId}`,
      envelope: { from: PEER_A, to: HOST, body: {} },
    })

    const afterProgress = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    const assignment = afterProgress.assignments.at(-1)!
    expect(afterProgress.ended).toBeUndefined()
    expect(assignment.state).toBe('running')
    expect(assignment.report?.kind).toBe('progress')

    // Progress is a heartbeat: releasing the slot would free remote capacity
    // while the worker is still running, and clearing the wait would leave a
    // hung remote Assignment with no timeout recovery.
    expect(runtime.placement.remoteHasTicket(ticketId)).toBe(true)

    await waitFor(() => {
      const ticket = runtime.store.getDoc<Ticket>('ticket', ticketId)
      return ticket?.assignments.at(-1)?.state === 'ended'
    }, RESULT_TIMEOUT_MS + 400, 'timeout after progress')

    const timedOut = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(timedOut.assignments.at(-1)?.report?.kind).toBe('failed')
    expect(timedOut.assignments.at(-1)?.report?.text).toContain('remote worker result timeout')
  })
})
