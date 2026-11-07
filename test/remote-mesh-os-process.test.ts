import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createA2AReplayCache, signA2ARequest } from '../src/channels/a2a-auth.ts'
import { RemoteMeshRegistry, createRemoteMeshHandler } from '../src/harness/remote-node.ts'
import type { RemoteMeshAssignmentResultEvent } from '../src/harness/remote-node.ts'
import { recordRemoteResult } from '../src/harness/remote-results.ts'
import { Store } from '../src/store/sqlite.ts'
import type { WorkerReport } from '../src/shared/ports.ts'
import { tempHome } from './fixtures.ts'

const HOST_PEER = 'router-os'
const WORKER_PEER = 'worker-os'
const SECRET = 'remote-mesh-os-process-secret-never-log-0123456789ab'
const WRONG_SECRET = 'remote-mesh-os-wrong-secret-never-log-0123456789ab'

const children: ChildProcess[] = []
const servers: Server[] = []
const homes: string[] = []
function markerPath(home: string): string {
  return path.join(home, '.remote-mesh-worker-ready')
}

function childEnv(
  workerHome: string,
  marker: string,
  hostResultUrl: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
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
  }
}

function spawnWorker(workerHome: string, hostResultUrl: string, extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const marker = markerPath(workerHome)
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/remote-mesh-worker-child.ts', workerHome],
    {
      cwd: process.cwd(),
      env: childEnv(workerHome, marker, hostResultUrl, extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  return child
}

async function waitForMarker(workerHome: string, timeoutMs = 30_000): Promise<{ url: string; pid: number }> {
  const file = markerPath(workerHome)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as { url: string; pid: number }
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for worker marker ${file}`)
}

async function listenHost(onResult: (event: RemoteMeshAssignmentResultEvent) => void): Promise<string> {
  const handler = createRemoteMeshHandler({
    localPeerId: HOST_PEER,
    resolveSecret: peer => (peer === WORKER_PEER ? SECRET : undefined),
    replayCache: createA2AReplayCache(),
    onAssignment: () => undefined,
    onAssignmentResult: event => { onResult(event); return undefined },
  })
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('host bind failed')
  return `http://127.0.0.1:${address.port}/a2a`
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

describe('remote mesh OS process boundary (loopback)', () => {
  it('worker Runtime in a separate process executes assignment and host applies idempotent result', async () => {
    const hostHome = tempHome()
    homes.push(hostHome)
    const workerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-worker-'))
    homes.push(workerHome)
    const results: RemoteMeshAssignmentResultEvent[] = []
    const hostResultUrl = await listenHost(event => { results.push(event) })

    spawnWorker(workerHome, hostResultUrl)
    const { url: workerUrl } = await waitForMarker(workerHome)

    const registry = new RemoteMeshRegistry({ localPeerId: HOST_PEER })
    registry.register({
      id: 'worker-os-node',
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 2,
    })
    const ticketId = 'ticket_os_mesh'
    const assignmentId = 'asg_os_mesh_1'
    expect(registry.pick(ticketId)?.id).toBe('worker-os-node')
    const delivery = await registry.dispatch(ticketId, {
      assignmentId,
      brief: 'run on remote os worker',
    })
    expect(delivery?.status).toBe('delivered')

    await new Promise(resolve => setTimeout(resolve, 200))

    const workerStore = new Store(workerHome)
    try {
      expect(workerStore.getDoc('mesh_worker_exec', ticketId)).toMatchObject({ assignmentId })
    } finally {
      workerStore.close()
    }

    expect(results).toHaveLength(1)
    const report = results[0]!.report as WorkerReport
    const hostStore = new Store(hostHome)
    try {
      expect(recordRemoteResult(hostStore, {
        ticketId,
        assignmentId,
        report,
        deliveryKey: results[0]!.deliveryKey,
      })).toBe(true)
      expect(recordRemoteResult(hostStore, {
        ticketId,
        assignmentId,
        report,
        deliveryKey: results[0]!.deliveryKey,
      })).toBe(false)
    } finally {
      hostStore.close()
    }
  }, 60_000)

  it('fails closed on secret mismatch at the worker inbox', async () => {
    const workerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-worker-bad-'))
    homes.push(workerHome)
    const hostResultUrl = await listenHost(() => undefined)
    spawnWorker(workerHome, hostResultUrl)
    const { url: workerUrl } = await waitForMarker(workerHome)

    const registry = new RemoteMeshRegistry({ localPeerId: HOST_PEER })
    registry.register({
      id: 'worker-os-node',
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: WRONG_SECRET,
    })
    expect(registry.pick('ticket_bad_secret')?.id).toBe('worker-os-node')
    const delivery = await registry.dispatch('ticket_bad_secret', { assignmentId: 'asg_1' })
    expect(delivery?.status).toBe('failed')
  }, 45_000)

  it('rejects replayed POST on the worker mesh inbox', async () => {
    const workerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-worker-replay-'))
    homes.push(workerHome)
    const hostResultUrl = await listenHost(() => undefined)
    spawnWorker(workerHome, hostResultUrl)
    const { url: workerUrl } = await waitForMarker(workerHome)

    const registerBody = JSON.stringify({
      to: WORKER_PEER,
      body: { kind: 'register', id: 'worker-os-node', url: workerUrl, capacity: 2 },
    })
    const regSigned = signA2ARequest({ peerId: HOST_PEER, secret: SECRET, body: registerBody })
    const regRes = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...regSigned.headers },
      body: registerBody,
    })
    expect(regRes.status).toBe(200)

    const body = JSON.stringify({
      to: WORKER_PEER,
      body: { kind: 'heartbeat', id: 'worker-os-node' },
    })
    const signed = signA2ARequest({ peerId: HOST_PEER, secret: SECRET, body })
    const headers = { 'content-type': 'application/json', ...signed.headers }
    const first = await fetch(workerUrl, { method: 'POST', headers, body })
    expect(first.status).toBeLessThan(500)
    const replay = await fetch(workerUrl, { method: 'POST', headers, body })
    expect(replay.status).toBe(401)
  }, 45_000)

  it('documents RemoteMeshRegistry does not auto-release when the worker process dies', async () => {
    const workerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-worker-kill-'))
    homes.push(workerHome)
    const hostResultUrl = await listenHost(() => undefined)
    const child = spawnWorker(workerHome, hostResultUrl, { DS_AGENT_MESH_WORKER_MODE: 'hang' })
    const { url: workerUrl, pid } = await waitForMarker(workerHome)

    const registry = new RemoteMeshRegistry({ localPeerId: HOST_PEER })
    registry.register({
      id: 'worker-os-node',
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
    })
    const ticketId = 'ticket_kill'
    expect(registry.pick(ticketId)?.id).toBe('worker-os-node')
    const delivery = await registry.dispatch(ticketId, { assignmentId: 'asg_kill' })
    expect(delivery?.status).toBe('delivered')
    expect(registry.inFlight('worker-os-node')).toBe(1)

    process.kill(pid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(registry.inFlight('worker-os-node')).toBe(1)

    registry.release(ticketId)
    expect(registry.inFlight('worker-os-node')).toBe(0)

    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 45_000)
})
