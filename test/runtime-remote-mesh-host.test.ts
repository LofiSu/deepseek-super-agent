import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { createA2AReplayCache } from '../src/channels/a2a-auth.ts'
import { createRemoteMeshHandler } from '../src/harness/remote-node.ts'
import { remoteResultSeen } from '../src/harness/remote-results.ts'
import type { Ticket } from '../src/shared/types.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, settleWithDeadline, shutdown } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel } from './scripted-model.ts'

const HOST_PEER = 'router-rt'
const WORKER_PEER = 'worker-rt'
const SECRET = 'runtime-remote-mesh-host-secret-0123456789ab'
const REMOTE_NODE_ID = 'remote-rt-node'

const children: ChildProcess[] = []
const servers: Server[] = []
const homes: string[] = []

interface Gate {
  promise: Promise<void>
  release: () => void
}

function gate(): Gate {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function markerPath(home: string): string {
  return path.join(home, '.remote-mesh-worker-ready')
}

function spawnWorker(workerHome: string, hostResultUrl: string, extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const marker = markerPath(workerHome)
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/remote-mesh-worker-child.ts', workerHome],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DS_AGENT_HOME: workerHome,
        NODE_NO_WARNINGS: '1',
        DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
        DS_AGENT_MESH_WORKER_MARKER: marker,
        DS_AGENT_MESH_HOST_RESULT_URL: hostResultUrl,
        DS_AGENT_MESH_WORKER_PEER_ID: WORKER_PEER,
        DS_AGENT_MESH_HOST_PEER_ID: HOST_PEER,
        DS_AGENT_MESH_SECRET: SECRET,
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  return child
}

async function waitForWorkerUrl(workerHome: string, timeoutMs = 30_000): Promise<string> {
  const file = markerPath(workerHome)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      return (JSON.parse(fs.readFileSync(file, 'utf8')) as { url: string }).url
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for worker marker ${file}`)
}

async function bindRemoteWorker(
  runtime: Runtime,
  workerMode?: string,
): Promise<string> {
  const handler = createRemoteMeshHandler({
    localPeerId: HOST_PEER,
    resolveSecret: peer => (peer === WORKER_PEER ? SECRET : undefined),
    replayCache: createA2AReplayCache(),
    onAssignment: () => undefined,
    onAssignmentResult: (event) => {
      runtime.applyRemoteAssignmentResult(event)
      return undefined
    },
  })
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('host bind failed')
  const hostResultUrl = `http://127.0.0.1:${address.port}/a2a`
  const workerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-worker-'))
  homes.push(workerHome)
  spawnWorker(workerHome, hostResultUrl, workerMode ? { DS_AGENT_MESH_WORKER_MODE: workerMode } : {})
  const workerUrl = await waitForWorkerUrl(workerHome)
  runtime.placement.registerRemoteNode({
    id: REMOTE_NODE_ID,
    url: workerUrl,
    peerId: WORKER_PEER,
    secret: SECRET,
    capacity: 2,
  })
  return workerUrl
}

function meshRuntime(home: string, model: ScriptedModel, remoteResultTimeoutMs: number): Runtime {
  return freshRuntime({
    home,
    model,
    meshCapacity: 1,
    instanceId: HOST_PEER,
    remoteResultTimeoutMs,
    jobDelayMs: 0,
    watchdogIntervalMs: 600_000,
    stuckMs: 600_000,
    env: {
      ...process.env,
      DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
      DS_AGENT_MESH_CAPACITY: '1',
      DS_AGENT_INSTANCE_ID: HOST_PEER,
    },
  })
}

/** Reserve the sole local slot without ending the assignment (plain Worker turn). */
function meshModel(held: Map<string, Gate>): ScriptedModel {
  return new ScriptedModel(async request => {
    if (request.role !== 'worker') return { text: 'router-ok' }
    const ticketId = field(lastPrompt(request), 'ticketId')
    const hold = held.get(ticketId)
    if (hold) {
      await hold.promise
      return { text: 'worker-done' }
    }
    const reported = request.messages.some(m => m.role === 'tool' && m.name === 'report_to_router')
    if (!reported) {
      return {
        toolCalls: [{
          id: `report_${ticketId}`,
          name: 'report_to_router',
          args: { ticketId, text: 'ready: ok', deliver: false, kind: 'ready' },
        }],
      }
    }
    return { text: 'worker-done' }
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

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => {
    s.close(() => resolve())
    s.closeAllConnections()
  })))
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('Runtime remote mesh host queue', () => {
  it('queues to remote child and applyRemoteAssignmentResult releases placement', async () => {
    const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-host-'))
    homes.push(hostHome)
    const held = new Map<string, Gate>()
    const runtime = meshRuntime(hostHome, meshModel(held), 60_000)
    await bindRemoteWorker(runtime)
    runtime.start({ assessPending: false })

    const blockId = createTicket(runtime, 'block_local')
    held.set(blockId, gate())
    void runtime.harness.launch(loadTicket(runtime, blockId))
    await new Promise(resolve => setTimeout(resolve, 40))

    const remoteId = createTicket(runtime, 'remote_ok')
    await runtime.harness.launch(loadTicket(runtime, remoteId))
    await settleWithDeadline(runtime, 45_000)

    const assignmentId = loadTicket(runtime, remoteId).assignments.at(-1)?.id ?? ''
    expect(remoteResultSeen(runtime.store, WORKER_PEER, `deliv-os-${remoteId}-${assignmentId}`)).toBe(true)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(0)
    expect(runtime.log.text()).toContain('[mesh] remote result applied')

    held.get(blockId)?.release()
    await shutdown(runtime)
  }, 90_000)

  it('releases placement on remote result timeout without manual registry.release', async () => {
    const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-host-to-'))
    homes.push(hostHome)
    const held = new Map<string, Gate>()
    const runtime = meshRuntime(hostHome, meshModel(held), 400)
    await bindRemoteWorker(runtime, 'no-result')
    runtime.start({ assessPending: false })

    const blockId = createTicket(runtime, 'block_to')
    held.set(blockId, gate())
    void runtime.harness.launch(loadTicket(runtime, blockId))
    await new Promise(resolve => setTimeout(resolve, 40))

    const remoteId = createTicket(runtime, 'remote_hang')
    await runtime.harness.launch(loadTicket(runtime, remoteId))
    await new Promise(resolve => setTimeout(resolve, 800))

    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(0)
    expect(runtime.log.text()).toContain('remote result timeout')

    held.get(blockId)?.release()
    await shutdown(runtime)
  }, 60_000)
})
