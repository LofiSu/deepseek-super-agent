/**
 * Separate-process remote mesh worker. Starts a real Runtime plus an A2A mesh inbox.
 * Used only from `test/remote-mesh-os-process.test.ts`.
 */
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import { A2AHttpTransport } from '../../src/channels/a2a-http.ts'
import { createA2AReplayCache } from '../../src/channels/a2a-auth.ts'
import { createRemoteMeshHandler } from '../../src/harness/remote-node.ts'
import type { RemoteMeshAssignmentEvent } from '../../src/harness/remote-node.ts'
import { Runtime } from '../../src/runtime.ts'
import { MockModel } from '../../src/harness/model.ts'

const home = process.argv[2]
const marker = process.env.DS_AGENT_MESH_WORKER_MARKER
const hostResultUrl = process.env.DS_AGENT_MESH_HOST_RESULT_URL?.trim()
const workerPeer = process.env.DS_AGENT_MESH_WORKER_PEER_ID?.trim() ?? 'worker-os'
const hostPeer = process.env.DS_AGENT_MESH_HOST_PEER_ID?.trim() ?? 'router-os'
const secret = process.env.DS_AGENT_MESH_SECRET?.trim()

if (!home || !marker || !hostResultUrl || !secret) {
  console.error('remote-mesh-worker-child: missing home, marker, host result url, or secret')
  process.exit(2)
}

const meshSecret = secret
const meshHostResultUrl = hostResultUrl
const meshMarker = marker

const runtime = Runtime.create({
  home,
  model: new MockModel(),
  jobDelayMs: 0,
  watchdogIntervalMs: 600_000,
  stuckMs: 600_000,
  env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1' },
})

let server: Server | undefined
const cancelledAssignments = new Set<string>()

function assignmentKey(ticketId: string, assignmentId: string): string {
  return `${ticketId}::${assignmentId}`
}

function assignmentRecord(event: RemoteMeshAssignmentEvent): void {
  const body = event.assignment
  const row = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const assignmentId = typeof row.assignmentId === 'string' ? row.assignmentId : 'asg_unknown'
  runtime.store.putDoc('mesh_worker_exec', event.ticketId, {
    assignmentId,
    receivedAt: new Date().toISOString(),
    peerId: event.peerId,
  })
  runtime.log.info(`[mesh-worker] assignment ticketId=${event.ticketId} assignmentId=${assignmentId}`)

  const mode = process.env.DS_AGENT_MESH_WORKER_MODE?.trim()
  if (mode === 'hang') return
  if (mode === 'no-result') return

  const key = assignmentKey(event.ticketId, assignmentId)
  if (cancelledAssignments.has(key)) return

  const sendResult = (): void => {
    if (cancelledAssignments.has(key)) return
    const deliveryKey = `deliv-os-${event.ticketId}-${assignmentId}`
    const transport = new A2AHttpTransport({ url: meshHostResultUrl, peerId: workerPeer, secret: meshSecret })
    void transport.send({
      from: workerPeer,
      to: hostPeer,
      body: {
        kind: 'assignment_result',
        ticketId: event.ticketId,
        assignmentId,
        deliveryKey,
        report: { kind: 'ready', text: 'remote os worker done', deliver: false },
      },
    })
  }

  if (mode === 'slow-result') {
    setTimeout(sendResult, 2_000).unref?.()
    return
  }
  sendResult()
}

async function main(): Promise<void> {
  runtime.start({ assessPending: false })
  const handler = createRemoteMeshHandler({
    localPeerId: workerPeer,
    allowLoopbackRegistration: true,
    resolveSecret: peer => (peer === hostPeer ? meshSecret : undefined),
    replayCache: createA2AReplayCache(),
    onAssignment: event => { assignmentRecord(event) },
    onAssignmentCancel: event => {
      cancelledAssignments.add(assignmentKey(event.ticketId, event.assignmentId))
      runtime.store.putDoc('mesh_worker_cancel', event.ticketId, {
        assignmentId: event.assignmentId,
        receivedAt: new Date().toISOString(),
        peerId: event.peerId,
      })
      runtime.log.info(
        `[mesh-worker] cancel ack ticketId=${event.ticketId} assignmentId=${event.assignmentId}`,
      )
    },
  })
  server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('bind failed')
  const url = `http://127.0.0.1:${address.port}/a2a`
  fs.writeFileSync(meshMarker, JSON.stringify({ url, pid: process.pid, workerPeer, hostPeer }))
  console.log(`remote-mesh-worker-child ready url=${url}`)
}

void main().catch(error => {
  console.error(String(error))
  process.exit(1)
})

function shutdown(): void {
  if (server) {
    server.close()
    server.closeAllConnections()
  }
  void runtime.finish().finally(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
