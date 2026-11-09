import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { ScriptedModel } from './scripted-model.ts'

const HOST_PEER = 'dispatch-fail-host'
const WORKER_PEER = 'dispatch-fail-worker'
const SECRET = 'dispatch-fail-secret-0123456789abcdef'
const REMOTE_NODE_ID = 'dispatch-fail-node'
// The in-process node advertises no capabilities, so a non-empty requirement
// forces placement onto the registered remote node.
const REQUIRED_CAPABILITY = 'dispatch-fail-only'

const servers: Server[] = []
const homes: string[] = []

function runtimeFor(home: string): Runtime {
  return freshRuntime({
    home,
    model: new ScriptedModel(async request => {
      // The Worker never runs: dispatch fails before a remote turn exists.
      if (request.role !== 'worker') return { text: 'router-ok' }
      return { text: 'worker-done' }
    }),
    meshCapacity: 1,
    instanceId: HOST_PEER,
    remoteResultTimeoutMs: 60_000,
    jobDelayMs: 0,
    watchdogIntervalMs: 600_000,
    stuckMs: 600_000,
    env: {
      ...process.env,
      DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
      DS_AGENT_MESH_CAPACITY: '1',
      DS_AGENT_INSTANCE_ID: HOST_PEER,
      DS_AGENT_REMOTE_MESH: '',
      DS_AGENT_MESH_REQUIRED_CAPABILITIES: REQUIRED_CAPABILITY,
    },
  })
}

function createTicket(runtime: Runtime, slug: string): string {
  runtime.engine.receive(imTrigger({
    id: `trg_${slug}`,
    thread: `topic/${slug}`,
    text: '@ds-agent fix checkout',
  }), { shards: ['default'] })
  const decision = runtime.engine.evaluateDue()[0]
  if (!decision?.ticketId) throw new Error('expected ticket')
  return decision.ticketId
}

function loadTicket(runtime: Runtime, ticketId: string): Ticket {
  const ticket = runtime.store.getDoc<Ticket>('ticket', ticketId)
  if (!ticket) throw new Error(`missing ticket ${ticketId}`)
  return ticket
}

async function waitFor(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (!predicate()) throw new Error(`timed out waiting for ${label}`)
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => {
    s.close(() => resolve())
    s.closeAllConnections()
  })))
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('Runtime remote mesh dispatch failure', () => {
  it('ends the Assignment and keeps the Ticket open when delivery fails', async () => {
    // A peer inbox that rejects every assignment with a non-2xx response. The
    // A2A transport maps that to `failed` (see a2a-http.ts), so `dispatch`
    // returns a non-delivered status and releases the mesh slot.
    const server = createServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'delivery failed' }))
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-dispatch-fail-'))
    homes.push(home)
    const runtime = runtimeFor(home)
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    })
    runtime.start({ assessPending: false })

    const ticketId = createTicket(runtime, 'dispatch_fail')
    await runtime.harness.launch(loadTicket(runtime, ticketId))

    await waitFor(
      () => runtime.log.text().includes(`[mesh] remote dispatch failed ticketId=${ticketId}`),
      5_000,
      'remote dispatch to fail',
    )

    const ticket = loadTicket(runtime, ticketId)
    const assignment = ticket.assignments.at(-1)
    expect(assignment).toBeDefined()

    // The Assignment is terminal and says why: without this it would stay
    // `running` on a remote node forever, because clearing the result wait
    // means no timeout will ever report.
    expect(assignment?.state).toBe('ended')
    expect(assignment?.report?.kind).toBe('failed')
    expect(assignment?.report?.text).toContain('remote dispatch failed')
    expect(assignment?.report?.text).toContain('failed')
    expect(assignment?.report?.deliver).toBe(false)

    // A failed Assignment must not end the Ticket: a later retry stays possible.
    expect(ticket.ended).toBeUndefined()

    // The failed delivery released the remote slot and dropped the sticky
    // assignment; capacity is reusable even though the Ticket is open.
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(0)
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(false)

    runtime.placement.release(ticketId)
    await shutdown(runtime)
  }, 60_000)
})
