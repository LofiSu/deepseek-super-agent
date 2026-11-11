import { createServer, request as httpRequest, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createA2AReplayCache } from '../src/channels/a2a-auth.ts'
import { imTrigger } from '../src/channels/im.ts'
import {
  createRemoteMeshHandler,
  type RemoteMeshAssignmentCancelEvent,
  type RemoteMeshAssignmentEvent,
} from '../src/harness/remote-node.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, settleWithDeadline, shutdown } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel } from './scripted-model.ts'

const HOST_PEER = 'cancel-pump-host'
const WORKER_PEER = 'cancel-pump-worker'
const SECRET = 'cancel-pump-secret-0123456789abcdef'
const REMOTE_NODE_ID = 'cancel-pump-node'

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

/** Hold the sole local slot with a long Worker turn; router turns just reply. */
function holdingModel(held: Map<string, Gate>): ScriptedModel {
  return new ScriptedModel(async request => {
    if (request.role !== 'worker') return { text: 'router-ok' }
    const ticketId = field(lastPrompt(request), 'ticketId')
    const hold = held.get(ticketId)
    if (hold) {
      await hold.promise
      return { text: 'worker-done' }
    }
    return { text: 'worker-done' }
  })
}

function runtimeFor(
  home: string,
  model: ScriptedModel,
  remoteResultTimeoutMs = 60_000,
  requiredCapabilities = '',
): Runtime {
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
      // No env-declared remote peers; the test registers its own loopback node
      // explicitly. A required capability forces placement onto that node even
      // when the restarted host has a free local slot.
      DS_AGENT_REMOTE_MESH: '',
      DS_AGENT_MESH_REQUIRED_CAPABILITIES: requiredCapabilities,
    },
  })
}

/** Assignment id carried in an inbound mesh assignment envelope. */
function assignmentIdOf(event: RemoteMeshAssignmentEvent): string {
  const assignment = event.assignment as { assignmentId?: string; id?: string } | undefined
  return assignment?.assignmentId ?? assignment?.id ?? ''
}

interface CancelDroppingProxy {
  url: string
  /** Cancels the proxy received but never forwarded to the worker handler. */
  dropped: Array<{ ticketId: string; assignmentId: string }>
  /** While true, `assignment_cancel` bodies are answered and dropped. */
  dropping: boolean
  /**
   * Delay before answering a dropped cancel with 502. Defaults to 0 (answer
   * immediately); a positive delay lets a replacement be placed while the
   * predecessor cancel is still in flight.
   */
  dropDelayMs: number
  /**
   * While `dropping`, cancels for these Assignment ids are forwarded after
   * their delay instead of dropped. This lets one Assignment's cancel be
   * delayed and then *delivered* while another's is genuinely lost, which is
   * the race the last-attempt/terminal settle ordering has to survive.
   */
  forwardDelays: Map<string, number>
  /** Delayed forwards that have been scheduled (possibly still in flight). */
  delayedForwards: Array<{ ticketId: string; assignmentId: string }>
}

/**
 * Loopback proxy in front of the worker handler. When `dropping` is set it
 * answers `assignment_cancel` with 502 without forwarding the body, faithfully
 * reproducing a cancel that never reached the worker (lost/failed send) while
 * still letting assignment bodies through. It answers immediately unless
 * `dropDelayMs` is set, so the runtime's keep-alive socket is never blocked and
 * a replacement can still be dispatched while the cancel is missing. An id
 * listed in `forwardDelays` is forwarded after that delay even while
 * `dropping` is set, so a test can delay-then-deliver one cancel while losing
 * another in the same batch.
 */
async function startCancelDroppingProxy(targetUrl: string): Promise<CancelDroppingProxy> {
  const target = new URL(targetUrl)
  const state: CancelDroppingProxy = {
    url: '',
    dropped: [],
    dropping: false,
    dropDelayMs: 0,
    forwardDelays: new Map(),
    delayedForwards: [],
  }
  const proxy = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const text = body.toString('utf8')
      const forward = (): void => {
        const headers = { ...req.headers, host: target.host }
        delete headers['content-length']
        delete headers['transfer-encoding']
        const forwarded = httpRequest({
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: { ...headers, 'content-length': String(body.length) },
        }, proxied => {
          res.writeHead(proxied.statusCode ?? 502, proxied.headers)
          proxied.pipe(res)
        })
        forwarded.on('error', () => {
          if (!res.headersSent) res.statusCode = 502
          res.end()
        })
        forwarded.end(body)
      }
      const reply = (): void => {
        // Re-read `dropping` when the delayed reply fires: a caller may restore
        // forwarding while the 502 is pending, and that must forward normally.
        if (state.dropping && text.includes('assignment_cancel')) {
          const ticket = text.match(/"ticketId"\s*:\s*"([^"]+)"/)
          const assignment = text.match(/"assignmentId"\s*:\s*"([^"]+)"/)
          state.dropped.push({
            ticketId: ticket?.[1] ?? '',
            assignmentId: assignment?.[1] ?? '',
          })
          res.statusCode = 502
          res.end('cancel dropped')
          return
        }
        forward()
      }
      if (state.dropping && text.includes('assignment_cancel')) {
        const assignmentId = text.match(/"assignmentId"\s*:\s*"([^"]+)"/)?.[1] ?? ''
        const forwardDelay = state.forwardDelays.get(assignmentId)
        if (forwardDelay !== undefined) {
          const ticket = text.match(/"ticketId"\s*:\s*"([^"]+)"/)
          state.delayedForwards.push({
            ticketId: ticket?.[1] ?? '',
            assignmentId,
          })
          setTimeout(forward, forwardDelay)
          return
        }
        if (state.dropDelayMs > 0) {
          setTimeout(reply, state.dropDelayMs)
          return
        }
      }
      reply()
    })
    req.on('error', () => {
      if (!res.headersSent) res.statusCode = 502
      res.end()
    })
  })
  servers.push(proxy)
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', () => resolve())
  })
  const address = proxy.address()
  if (typeof address !== 'object' || address === null) throw new Error('proxy bind failed')
  state.url = `http://127.0.0.1:${address.port}/a2a`
  return state
}

interface CancelDelayingProxy {
  url: string
  delayMs: number
  /** While true, `assignment_cancel` bodies are forwarded after `delayMs`. */
  delaying: boolean
  /** Cancels the proxy read and held before forwarding. */
  held: Array<{ ticketId: string; assignmentId: string }>
}

/**
 * Loopback proxy in front of the worker handler that *delays* (never drops)
 * `assignment_cancel` forwarding by `delayMs`, while forwarding assignment
 * bodies immediately. This reproduces a slow cancel HTTP leg on the host under
 * observation, so a replacement dispatched ahead of the cancel reaches the
 * Worker first. Unlike the dropping proxy it eventually delivers the cancel and
 * only stretches the send's settle time, which is what the launch ordering
 * contract has to survive.
 */
async function startCancelDelayingProxy(
  targetUrl: string,
  delayMs = 400,
): Promise<CancelDelayingProxy> {
  const target = new URL(targetUrl)
  const state: CancelDelayingProxy = { url: '', delayMs, delaying: false, held: [] }
  const proxy = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const text = body.toString('utf8')
      const forward = (): void => {
        const headers = { ...req.headers, host: target.host }
        delete headers['content-length']
        delete headers['transfer-encoding']
        const forwarded = httpRequest({
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: { ...headers, 'content-length': String(body.length) },
        }, proxied => {
          res.writeHead(proxied.statusCode ?? 502, proxied.headers)
          proxied.pipe(res)
        })
        forwarded.on('error', () => {
          if (!res.headersSent) res.statusCode = 502
          res.end()
        })
        forwarded.end(body)
      }
      if (state.delaying && text.includes('assignment_cancel')) {
        const ticket = text.match(/"ticketId"\s*:\s*"([^"]+)"/)
        const assignment = text.match(/"assignmentId"\s*:\s*"([^"]+)"/)
        state.held.push({
          ticketId: ticket?.[1] ?? '',
          assignmentId: assignment?.[1] ?? '',
        })
        setTimeout(forward, state.delayMs)
        return
      }
      forward()
    })
    req.on('error', () => {
      if (!res.headersSent) res.statusCode = 502
      res.end()
    })
  })
  servers.push(proxy)
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', () => resolve())
  })
  const address = proxy.address()
  if (typeof address !== 'object' || address === null) throw new Error('proxy bind failed')
  state.url = `http://127.0.0.1:${address.port}/a2a`
  return state
}

interface SelectiveCancelProxy {
  url: string
  /** Cancel bodies the proxy answered 502 without forwarding. */
  dropped: Array<{ ticketId: string; assignmentId: string }>
  /** Cancel bodies the proxy held and then forwarded after `delayMs`. */
  delayed: Array<{ ticketId: string; assignmentId: string }>
  /** While an id is in the set, its `assignment_cancel` body is answered 502. */
  dropIds: Set<string>
  /** Ids whose `assignment_cancel` body is forwarded after `delayMs`. */
  delayIds: Set<string>
  delayMs: number
}

/**
 * Loopback proxy in front of the worker handler that can lose one Assignment's
 * cancel while delaying (and then delivering) another's.
 *
 * The dropping proxy loses *every* cancel and the delaying proxy delays *every*
 * cancel. A race where a later Ticket waits on one delayed cancel while a
 * different Ticket's cancel is lost and later resent needs both behaviors at
 * once. Membership is read per request, so a caller can restore forwarding for
 * one id once its first send has settled and let the post-wait resend through.
 * Assignment bodies are always forwarded immediately.
 */
async function startSelectiveCancelProxy(
  targetUrl: string,
  delayMs = 1_000,
): Promise<SelectiveCancelProxy> {
  const target = new URL(targetUrl)
  const state: SelectiveCancelProxy = {
    url: '',
    dropped: [],
    delayed: [],
    dropIds: new Set(),
    delayIds: new Set(),
    delayMs,
  }
  const proxy = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const text = body.toString('utf8')
      const ticketId = text.match(/"ticketId"\s*:\s*"([^"]+)"/)?.[1] ?? ''
      const assignmentId = text.match(/"assignmentId"\s*:\s*"([^"]+)"/)?.[1] ?? ''
      const forward = (): void => {
        const headers = { ...req.headers, host: target.host }
        delete headers['content-length']
        delete headers['transfer-encoding']
        const forwarded = httpRequest({
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: { ...headers, 'content-length': String(body.length) },
        }, proxied => {
          res.writeHead(proxied.statusCode ?? 502, proxied.headers)
          proxied.pipe(res)
        })
        forwarded.on('error', () => {
          if (!res.headersSent) res.statusCode = 502
          res.end()
        })
        forwarded.end(body)
      }
      if (text.includes('assignment_cancel')) {
        if (state.dropIds.has(assignmentId)) {
          state.dropped.push({ ticketId, assignmentId })
          res.statusCode = 502
          res.end('cancel dropped')
          return
        }
        if (state.delayIds.has(assignmentId)) {
          state.delayed.push({ ticketId, assignmentId })
          setTimeout(forward, state.delayMs)
          return
        }
      }
      forward()
    })
    req.on('error', () => {
      if (!res.headersSent) res.statusCode = 502
      res.end()
    })
  })
  servers.push(proxy)
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', () => resolve())
  })
  const address = proxy.address()
  if (typeof address !== 'object' || address === null) throw new Error('proxy bind failed')
  state.url = `http://127.0.0.1:${address.port}/a2a`
  return state
}

interface InboxStamp {
  kind: 'assignment' | 'cancel'
  assignmentId: string
  at: number
}

interface WorkerInbox {
  assignments: RemoteMeshAssignmentEvent[]
  cancels: RemoteMeshAssignmentCancelEvent[]
  /** Arrival order at the worker handler, used to assert cancel-before-dispatch. */
  stamps: InboxStamp[]
  url: string
}

async function startWorkerInbox(localPeerId = WORKER_PEER): Promise<WorkerInbox> {
  const assignments: RemoteMeshAssignmentEvent[] = []
  const cancels: RemoteMeshAssignmentCancelEvent[] = []
  const stamps: InboxStamp[] = []
  const workerHandler = createRemoteMeshHandler({
    localPeerId,
    replayCache: createA2AReplayCache(),
    resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
    onAssignment: (event) => {
      assignments.push(event)
      stamps.push({ kind: 'assignment', assignmentId: assignmentIdOf(event), at: Date.now() })
      return undefined
    },
    onAssignmentCancel: (event) => {
      cancels.push(event)
      stamps.push({ kind: 'cancel', assignmentId: event.assignmentId, at: Date.now() })
      return undefined
    },
  })
  const worker = createServer(workerHandler)
  servers.push(worker)
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject)
    worker.listen(0, '127.0.0.1', () => resolve())
  })
  const workerAddress = worker.address()
  if (typeof workerAddress !== 'object' || workerAddress === null) throw new Error('worker bind failed')
  return {
    assignments,
    cancels,
    stamps,
    url: `http://127.0.0.1:${workerAddress.port}/a2a`,
  }
}

/** Index of the first matching stamp, or -1. */
function stampIndex(
  stamps: InboxStamp[],
  kind: InboxStamp['kind'],
  assignmentId: string,
): number {
  return stamps.findIndex(stamp => stamp.kind === kind && stamp.assignmentId === assignmentId)
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

/**
 * Drive the production lost-A1 window: Runtime A launches running remote A1,
 * crashes without cancelling; Runtime B `start()`s on the same home, recovery
 * ends A1 and dispatches A2 onto the same Worker, and the proxy drops A1's
 * `assignment_cancel` so the Worker never sees it. A2 is persisted `running`
 * in process B when this resolves.
 *
 * The proxy is left in `dropping` mode. Callers turn it off to observe what
 * this same process sends when A2 later ends.
 */
async function setupLostA1ThenRunningA2(slug: string) {
  const assignments: RemoteMeshAssignmentEvent[] = []
  const cancels: RemoteMeshAssignmentCancelEvent[] = []
  const workerHandler = createRemoteMeshHandler({
    localPeerId: WORKER_PEER,
    replayCache: createA2AReplayCache(),
    resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
    onAssignment: (event) => {
      assignments.push(event)
      return undefined
    },
    onAssignmentCancel: (event) => {
      cancels.push(event)
      return undefined
    },
  })
  const worker = createServer(workerHandler)
  servers.push(worker)
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject)
    worker.listen(0, '127.0.0.1', () => resolve())
  })
  const workerAddress = worker.address()
  if (typeof workerAddress !== 'object' || workerAddress === null) throw new Error('worker bind failed')
  const proxy = await startCancelDroppingProxy(`http://127.0.0.1:${workerAddress.port}/a2a`)

  // A required capability forces every placement onto this remote node, so a
  // restarted host with a free local slot still dispatches there. Ticket rows
  // below are written only by production recovery / launch / report.
  const REQUIRED_CAPABILITY = `cancel-lost-same-process-${slug}`
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ds-mesh-cancel-lost-same-process-${slug}-`))
  homes.push(home)
  const node = {
    id: REMOTE_NODE_ID,
    url: proxy.url,
    peerId: WORKER_PEER,
    secret: SECRET,
    capacity: 1,
    capabilities: [REQUIRED_CAPABILITY],
  }
  const newRuntime = (): Runtime =>
    runtimeFor(home, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)

  const runtimeA = newRuntime()
  runtimeA.placement.registerRemoteNode(node)
  runtimeA.start({ assessPending: false })

  const ticketId = createTicket(runtimeA, slug)
  await runtimeA.harness.launch(loadTicket(runtimeA, ticketId))
  await waitFor(
    () => assignments.some(event => event.ticketId === ticketId),
    5_000,
    'A1 to reach the remote inbox',
  )
  const a1 = loadTicket(runtimeA, ticketId).assignments.at(-1)!
  expect(a1.node).toBe(REMOTE_NODE_ID)
  expect(a1.state).toBe('running')
  expect(runtimeA.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
  runtimeA.daemon.stop()
  runtimeA.store.close()
  expect(cancels).toHaveLength(0)

  proxy.dropping = true
  const runtimeB = newRuntime()
  runtimeB.placement.registerRemoteNode(node)
  runtimeB.start({ assessPending: false })

  const recoveredB = loadTicket(runtimeB, ticketId)
  const a2 = recoveredB.assignments.at(-1)!
  expect(a2.id).not.toBe(a1.id)
  expect(recoveredB.assignments.find(item => item.id === a1.id)?.state).toBe('ended')
  await waitFor(
    () => assignments.some(event => assignmentIdOf(event) === a2.id),
    5_000,
    'A2 to reach the remote inbox',
  )
  await waitFor(
    () => loadTicket(runtimeB, ticketId).assignments
      .some(item => item.id === a2.id && item.state === 'running'),
    5_000,
    'A2 to be persisted as running on the remote node',
  )
  expect(loadTicket(runtimeB, ticketId).assignments.find(item => item.id === a2.id)?.node)
    .toBe(REMOTE_NODE_ID)
  await waitFor(
    () => proxy.dropped.some(item => item.assignmentId === a1.id),
    5_000,
    'B to attempt the lost A1 cancel',
  )
  // The dropped cancel never reached the Worker.
  expect(cancels).toHaveLength(0)

  return { assignments, cancels, proxy, runtimeB, ticketId, a1, a2, home, node, newRuntime }
}

/**
 * Drive the A1-only lost-cancel window: Runtime A runs the Ticket's only
 * remote Assignment A1, a production report ends A1 (and, for `ready`, the
 * Ticket), then the process dies in the same turn before the queued
 * `releaseSlot` can send A1's cancel. Unlike `setupLostA1ThenRunningA2` this
 * leaves no superseded predecessor, so the ended latest itself is the only
 * leftover-restore signal. Runtime B is started on the same home and node for
 * the caller to observe.
 */
async function setupA1OnlyEndedRemote(slug: string, kind: 'ready' | 'failed') {
  const inbox = await startWorkerInbox()
  const REQUIRED_CAPABILITY = `cancel-lost-a1-only-${slug}`
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ds-mesh-cancel-a1-only-${slug}-`))
  homes.push(home)
  const node = {
    id: REMOTE_NODE_ID,
    url: inbox.url,
    peerId: WORKER_PEER,
    secret: SECRET,
    capacity: 1,
    capabilities: [REQUIRED_CAPABILITY],
  }
  const newRuntime = (): Runtime =>
    runtimeFor(home, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)

  // Runtime A: the Ticket's only Assignment is dispatched to the remote node.
  const runtimeA = newRuntime()
  runtimeA.placement.registerRemoteNode(node)
  runtimeA.start({ assessPending: false })
  const ticketId = createTicket(runtimeA, slug)
  await runtimeA.harness.launch(loadTicket(runtimeA, ticketId))
  await waitFor(
    () => inbox.assignments.some(event => event.ticketId === ticketId),
    5_000,
    'A1 to reach the remote inbox',
  )
  const a1 = loadTicket(runtimeA, ticketId).assignments.at(-1)!
  expect(a1.node).toBe(REMOTE_NODE_ID)
  expect(a1.state).toBe('running')
  expect(loadTicket(runtimeA, ticketId).assignments).toHaveLength(1)

  // Production report path: `ready` ends A1 and the Ticket; `failed` leaves the
  // Ticket open and ends only A1. In both cases A1 is the ended latest with no
  // predecessor.
  const reported = runtimeA.engine.report(ticketId, {
    kind,
    text: kind === 'ready' ? 'remote done' : 'remote worker result timeout',
    deliver: false,
  })
  expect(reported.surfaced).toBe(false)

  const afterReport = loadTicket(runtimeA, ticketId)
  expect(afterReport.assignments).toHaveLength(1)
  expect(afterReport.assignments.at(-1)?.id).toBe(a1.id)
  expect(afterReport.assignments.at(-1)?.state).toBe('ended')
  if (kind === 'ready') expect(afterReport.ended).toBeDefined()
  else expect(afterReport.ended).toBeUndefined()

  // Crash in the same turn: the queued `releaseSlot` microtask has not run, so
  // no `assignment_cancel` leaves this process.
  runtimeA.daemon.stop()
  runtimeA.store.close()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(inbox.cancels).toHaveLength(0)

  // Runtime B: a fresh process on the same persisted state and remote node.
  const runtimeB = newRuntime()
  runtimeB.placement.registerRemoteNode(node)
  runtimeB.start({ assessPending: false })

  return { inbox, runtimeB, ticketId, a1, node, newRuntime }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => {
    s.close(() => resolve())
    s.closeAllConnections()
  })))
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('Runtime remote mesh cancel releases capacity', () => {
  it('pumps a queued Worker after a remote cancel frees the only remote slot', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
      // Accept the assignment and never send a result: the host only learns the
      // Worker is gone when it cancels the assignment (remote result timeout).
      onAssignment: (event) => {
        assignments.push(event)
        return undefined
      },
      onAssignmentCancel: (event) => {
        cancels.push(event)
        return undefined
      },
    })
    const server = createServer(workerHandler)
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-pump-'))
    homes.push(hostHome)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(hostHome, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    // A held local Worker keeps the capacity-1 local node full for the whole
    // test, so both tickets below can only use the single remote node.
    const blockerId = createTicket(runtime, 'blocker')
    held.set(blockerId, gate())
    void runtime.harness.launch(loadTicket(runtime, blockerId))
    await waitFor(
      () => runtime.placement.local.inFlight(HOST_PEER) === 1,
      5_000,
      'local worker to reserve the only local slot',
    )

    const remoteTicketId = createTicket(runtime, 'remote_a')
    await runtime.harness.launch(loadTicket(runtime, remoteTicketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === remoteTicketId),
      5_000,
      'ticket A to reach the remote inbox',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    expect(runtime.log.text()).toContain(`[mesh] remote dispatch ticketId=${remoteTicketId}`)

    // The remote slot is full, so ticket B must park in the mesh queue.
    const queuedTicketId = createTicket(runtime, 'remote_b')
    const queuedLaunch = runtime.harness.launch(loadTicket(runtime, queuedTicketId))
    await waitFor(
      () => runtime.log.text().includes(`[mesh] mesh.queued ticketId=${queuedTicketId}`),
      5_000,
      'ticket B to queue behind the full remote node',
    )
    expect(assignments.some(event => event.ticketId === queuedTicketId)).toBe(false)

    // End A's Assignment without ending the Ticket, exactly like the remote
    // result timeout path. The cancel HTTP completes only after a few event
    // loop turns; nothing else in this test pumps afterwards.
    const failed = runtime.engine.report(remoteTicketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    expect(failed.surfaced).toBe(false)

    await waitFor(
      () => cancels.some(event => event.ticketId === remoteTicketId),
      5_000,
      'inbox to receive the cancel for ticket A',
    )
    await waitFor(
      () => assignments.some(event => event.ticketId === queuedTicketId),
      5_000,
      'ticket B to be dispatched to the freed remote node',
    )
    // B now owns the freed slot; capacity was returned between the cancel
    // settling and B's dispatch.
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    expect(runtime.log.text()).toContain(`[mesh] mesh.dequeued ticketId=${queuedTicketId}`)
    expect(runtime.log.text()).toContain(`[mesh] remote dispatch ticketId=${queuedTicketId}`)

    queuedLaunch.catch(() => undefined)
    held.get(blockerId)?.release()
    await settleWithDeadline(runtime, 10_000).catch(() => undefined)
    await shutdown(runtime)
  }, 60_000)

  it('pumps a queued retry when a remote node becomes eligible again on heartbeat', async () => {
    const REQUIRED_CAPABILITY = 'heartbeat-requeue-capability'
    const worker = await startWorkerInbox()
    const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-heartbeat-requeue-'))
    homes.push(hostHome)
    const runtime = runtimeFor(hostHome, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: worker.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    })
    runtime.start({ assessPending: false })

    // A required capability keeps both Assignments off the free local slot.
    const ticketId = createTicket(runtime, 'heartbeat_requeue')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => worker.assignments.some(event => event.ticketId === ticketId),
      5_000,
      'A1 to reach the remote inbox',
    )
    const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
    expect(a1.node).toBe(REMOTE_NODE_ID)

    // The only eligible node goes offline, then A1 ends without ending the
    // Ticket. The fail-soft cancel cannot reach the offline worker.
    const remote = runtime.placement.remote
    if (!remote) throw new Error('missing remote registry')
    expect(remote.markOffline(REMOTE_NODE_ID)).toBe(true)
    expect(runtime.engine.report(ticketId, {
      kind: 'failed',
      text: 'a1 failed while the node was offline',
      deliver: false,
    }).surfaced).toBe(false)
    await waitFor(
      () => loadTicket(runtime, ticketId).assignments.find(item => item.id === a1.id)?.state === 'ended',
      5_000,
      'A1 to end',
    )

    // No eligible node remains, so the retry replacement parks in the FIFO.
    const retry = runtime.retry(ticketId, 'retry after the node went offline')
    await waitFor(
      () => runtime.log.text().includes(`mesh.queued ticketId=${ticketId}`),
      5_000,
      'the retry replacement to queue while the node is offline',
    )
    const a2 = loadTicket(runtime, ticketId).assignments.at(-1)!
    expect(a2.id).not.toBe(a1.id)
    expect(worker.assignments.some(event => assignmentIdOf(event) === a2.id)).toBe(false)

    // The production "node is back" event. Nothing else ends or launches here,
    // so only the heartbeat can wake the parked replacement.
    expect(remote.heartbeat(REMOTE_NODE_ID)).toBe(true)
    await waitFor(
      () => worker.assignments.some(event => assignmentIdOf(event) === a2.id),
      5_000,
      'the queued replacement body to reach the returned node',
    )
    expect(runtime.log.text()).toContain(`[mesh] mesh.dequeued ticketId=${ticketId}`)
    expect(runtime.log.text()).toContain(`[mesh] remote dispatch ticketId=${ticketId}`)
    expect(loadTicket(runtime, ticketId).assignments.at(-1)?.node).toBe(REMOTE_NODE_ID)
    // The queued launch (and therefore Runtime.retry) completes once the body
    // is dispatched; no third Ticket was launched to force the pump.
    await retry

    await shutdown(runtime)
  }, 60_000)

  it('pumps a parked Worker when a remote node is late-bound by register', async () => {
    const REQUIRED_CAPABILITY = 'late-register-capability'
    const worker = await startWorkerInbox()
    const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-late-register-'))
    homes.push(hostHome)
    const runtime = runtimeFor(hostHome, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)
    runtime.start({ assessPending: false })

    // No remote node exists yet and the required capability keeps the free
    // local slot from absorbing the work, so the first launch parks in the FIFO.
    const firstTicketId = createTicket(runtime, 'late_register_a')
    const firstLaunch = runtime.harness.launch(loadTicket(runtime, firstTicketId))
    await waitFor(
      () => runtime.log.text().includes(`mesh.queued ticketId=${firstTicketId}`),
      5_000,
      'the first ticket to queue with no eligible node',
    )
    const a1 = loadTicket(runtime, firstTicketId).assignments.at(-1)!
    expect(a1.state).toBe('pending')
    expect(worker.assignments.some(event => assignmentIdOf(event) === a1.id)).toBe(false)

    // The production late-bind event: the worker inbox URL is now known. No
    // other ticket launches or ends here, so only the register hook can wake
    // the parked FIFO.
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: worker.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    })
    await waitFor(
      () => worker.assignments.some(event => assignmentIdOf(event) === a1.id),
      5_000,
      'the queued first-ticket body to reach the late-bound node',
    )
    expect(runtime.log.text()).toContain(`[mesh] mesh.dequeued ticketId=${firstTicketId}`)
    expect(runtime.log.text()).toContain(`[mesh] remote dispatch ticketId=${firstTicketId}`)
    expect(loadTicket(runtime, firstTicketId).assignments.at(-1)?.node).toBe(REMOTE_NODE_ID)
    // The parked launch completes once the body is dispatched; no second Ticket
    // was launched to force the pump.
    await firstLaunch

    // The late-bound node's only slot is now held by the first ticket, so a
    // later ticket still queues behind it instead of jumping the FIFO.
    const secondTicketId = createTicket(runtime, 'late_register_b')
    const secondLaunch = runtime.harness.launch(loadTicket(runtime, secondTicketId))
    await waitFor(
      () => runtime.log.text().includes(`mesh.queued ticketId=${secondTicketId}`),
      5_000,
      'the second ticket to queue behind the busy late-bound node',
    )
    expect(worker.assignments.some(event => event.ticketId === secondTicketId)).toBe(false)

    secondLaunch.catch(() => undefined)
    // Drain resolves the parked second launch so shutdown does not wait on it.
    await runtime.drain()
    await shutdown(runtime)
  }, 60_000)

  it('pumps a Ticket parked behind a pause-held terminal remote result', async () => {
    const REQUIRED_CAPABILITY = 'held-terminal-capability'
    const worker = await startWorkerInbox()
    const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-held-terminal-'))
    homes.push(hostHome)
    const runtime = runtimeFor(hostHome, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: worker.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    })
    runtime.start({ assessPending: false })

    // The required capability keeps every Assignment off the free local slot.
    const firstTicketId = createTicket(runtime, 'held_terminal_a')
    const firstLaunch = runtime.harness.launch(loadTicket(runtime, firstTicketId))
    await waitFor(
      () => worker.assignments.some(event => event.ticketId === firstTicketId),
      5_000,
      'T1 to reach the remote node',
    )
    const a1 = loadTicket(runtime, firstTicketId).assignments.at(-1)!
    expect(a1.node).toBe(REMOTE_NODE_ID)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    // Pausing freezes T1 after A1 is placed; the remote slot stays held.
    expect(runtime.pause(firstTicketId).changed).toBe(true)

    // The only eligible node is full, so T2 must park in the mesh FIFO.
    const secondTicketId = createTicket(runtime, 'held_terminal_b')
    const secondLaunch = runtime.harness.launch(loadTicket(runtime, secondTicketId))
    await waitFor(
      () => runtime.log.text().includes(`mesh.queued ticketId=${secondTicketId}`),
      5_000,
      'T2 to queue behind the busy node',
    )
    const a2 = loadTicket(runtime, secondTicketId).assignments.at(-1)!
    expect(a2.state).toBe('pending')
    expect(worker.assignments.some(event => assignmentIdOf(event) === a2.id)).toBe(false)

    // The Worker finishes A1 while T1 is paused. The pause holds the terminal
    // verdict and keeps A1 open, but the remote work is done, so the mesh slot
    // must be freed and the parked FIFO woken. No other Ticket is launched or
    // ended here to force a pump.
    runtime.applyRemoteAssignmentResult({
      peerId: WORKER_PEER,
      ticketId: firstTicketId,
      assignmentId: a1.id,
      report: { kind: 'ready', text: 'remote work done', deliver: false },
      deliveryKey: `deliv-held-terminal-${firstTicketId}`,
      envelope: { from: WORKER_PEER, to: HOST_PEER, body: {} },
    })

    const paused = loadTicket(runtime, firstTicketId)
    expect(paused.collab?.paused).toBeDefined()
    expect(paused.ended).toBeUndefined()
    expect(paused.assignments.at(-1)?.id).toBe(a1.id)
    expect(paused.assignments.at(-1)?.state).toBe('running')
    expect(paused.assignments.at(-1)?.report?.kind).toBe('ready')
    expect(runtime.placement.remoteHasTicket(firstTicketId)).toBe(false)

    // The freed slot wakes the parked head: T2 dequeues and reaches the node.
    await waitFor(
      () => worker.assignments.some(event => assignmentIdOf(event) === a2.id),
      5_000,
      'T2 to be dispatched to the freed node',
    )
    expect(runtime.log.text()).toContain(`[mesh] mesh.dequeued ticketId=${secondTicketId}`)
    expect(runtime.log.text()).toContain(`[mesh] remote dispatch ticketId=${secondTicketId}`)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    expect(loadTicket(runtime, secondTicketId).assignments.at(-1)?.node).toBe(REMOTE_NODE_ID)
    await secondLaunch

    // T2 now holds the only slot, so a later T3 queues instead of jumping it.
    const thirdTicketId = createTicket(runtime, 'held_terminal_c')
    const thirdLaunch = runtime.harness.launch(loadTicket(runtime, thirdTicketId))
    await waitFor(
      () => runtime.log.text().includes(`mesh.queued ticketId=${thirdTicketId}`),
      5_000,
      'T3 to queue behind T2',
    )
    expect(worker.assignments.some(event => event.ticketId === thirdTicketId)).toBe(false)

    thirdLaunch.catch(() => undefined)
    firstLaunch.catch(() => undefined)
    // Drain resolves the parked launches so shutdown does not wait on them.
    await runtime.drain()
    await shutdown(runtime)
  }, 60_000)

  it('keeps a live replacement slot when the cancel releases an ended Assignment', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
      onAssignment: (event) => {
        assignments.push(event)
        return undefined
      },
      onAssignmentCancel: (event) => {
        cancels.push(event)
        return undefined
      },
    })
    const server = createServer(workerHandler)
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-live-replacement-'))
    homes.push(home)
    const runtime = runtimeFor(home, holdingModel(new Map()))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    // Occupy the only local slot so placement must choose the remote node.
    expect(runtime.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtime, 'cancel_live_replacement')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    const current = loadTicket(runtime, ticketId)
    const armed = current.assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // End the armed Assignment through the normal report path. `onAssignmentEnded`
    // queues the cancel/release microtask.
    const failed = runtime.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    expect(failed.surfaced).toBe(false)
    const afterReport = loadTicket(runtime, ticketId)
    const ended = afterReport.assignments.at(-1)!
    expect(ended.id).toBe(armed.id)
    expect(ended.state).toBe('ended')

    // Before the release microtask runs, commit a replacement that already
    // claimed the same remote node and started. The sticky reservation stays,
    // so the replacement owns the ticket's remote slot.
    const replacementAssignment = {
      id: 'asg_cancel_live_replacement',
      state: 'running' as const,
      speculative: false,
      node: REMOTE_NODE_ID,
      startedAt: new Date().toISOString(),
    }
    runtime.store.putDoc('ticket', ticketId, {
      ...afterReport,
      assignments: [...afterReport.assignments, replacementAssignment],
    })

    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId),
      5_000,
      'inbox to receive the cancel for the ended Assignment',
    )
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote cancel kept slot ticketId=${ticketId} assignmentId=${armed.id} replacementId=${replacementAssignment.id}`,
      ),
      5_000,
      'late cancel to keep the live replacement slot',
    )

    // The ended remote worker is still told to stop; the live replacement is
    // neither cancelled nor touched.
    expect(cancels.find(event => event.ticketId === ticketId)?.assignmentId).toBe(armed.id)
    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacementAssignment.id)
    expect(latest.state).toBe('running')
    expect(latest.report).toBeUndefined()
    expect(after.ended).toBeUndefined()
    // The cancel must not steal the live replacement's mesh capacity.
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(true)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    await shutdown(runtime)
  }, 60_000)

  it('re-arms the live replacement wait after a late cancel keep-slot', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
      onAssignment: (event) => {
        assignments.push(event)
        return undefined
      },
      onAssignmentCancel: (event) => {
        cancels.push(event)
        return undefined
      },
    })
    const server = createServer(workerHandler)
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-live-replacement-rearm-'))
    homes.push(home)
    const runtime = runtimeFor(home, holdingModel(new Map()), 300)
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    // Occupy the only local slot so placement must choose the remote node.
    expect(runtime.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtime, 'late_cancel_rearm')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    const current = loadTicket(runtime, ticketId)
    const armed = current.assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // Let the original wait arm first so the later transfer is a distinct arm.
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote result wait armed ticketId=${ticketId} assignmentId=${armed.id}`,
      ),
      5_000,
      'remote result wait to arm before the report',
    )

    // End the armed Assignment through the normal report path. `onAssignmentEnded`
    // clears the per-ticket wait and queues the cancel/release microtask.
    const failed = runtime.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    expect(failed.surfaced).toBe(false)
    const afterReport = loadTicket(runtime, ticketId)
    const ended = afterReport.assignments.at(-1)!
    expect(ended.id).toBe(armed.id)
    expect(ended.state).toBe('ended')

    // Before the release microtask runs, commit a replacement that already
    // claimed the same remote node and started, with no wait of its own. The
    // cancel keep-slot path must transfer the wait onto it.
    const replacementAssignment = {
      id: 'asg_cancel_live_replacement_rearm',
      state: 'running' as const,
      speculative: false,
      node: REMOTE_NODE_ID,
      startedAt: new Date().toISOString(),
    }
    runtime.store.putDoc('ticket', ticketId, {
      ...afterReport,
      assignments: [...afterReport.assignments, replacementAssignment],
    })

    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote cancel kept slot ticketId=${ticketId} assignmentId=${armed.id} replacementId=${replacementAssignment.id}`,
      ),
      5_000,
      'late cancel to keep the live replacement slot',
    )
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote result wait armed ticketId=${ticketId} assignmentId=${replacementAssignment.id}`,
      ),
      5_000,
      'cancel keep-slot to transfer the wait to the live replacement',
    )

    // The transferred wait now fires for the replacement: report the failed
    // timeout, end the hung replacement, and free the sticky slot.
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote result timeout ticketId=${ticketId} assignmentId=${replacementAssignment.id}`,
      ),
      5_000,
      'replacement result timeout to fire',
    )
    await waitFor(
      () => loadTicket(runtime, ticketId).assignments.at(-1)!.state === 'ended',
      5_000,
      'replacement Assignment to end after its timeout',
    )
    await waitFor(
      () => runtime.placement.remote?.hasTicketAssignment(ticketId) === false,
      5_000,
      'sticky remote slot to be released after the replacement timeout',
    )

    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacementAssignment.id)
    expect(latest.report?.kind).toBe('failed')
    expect(latest.report?.text).toBe('remote worker result timeout')
    expect(after.ended).toBeUndefined()
    // The cancel still targets the ended Assignment, not the replacement.
    expect(cancels.find(event => event.ticketId === ticketId)?.assignmentId).toBe(armed.id)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(0)

    await shutdown(runtime)
  }, 60_000)

  it('keeps a retry replacement slot when the cancel settles after it is dispatched', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
      onAssignment: (event) => {
        assignments.push(event)
        return undefined
      },
      onAssignmentCancel: (event) => {
        cancels.push(event)
        return undefined
      },
    })
    // Hold the cancel request (the first request after the release microtask
    // starts it) at the inbox until the retry replacement has been launched,
    // placed, and dispatched. The send must not settle before then.
    const cancelGate = gate()
    let holdNextRequest = false
    let onCancelHeld!: () => void
    const cancelHeld = new Promise<void>(resolve => { onCancelHeld = resolve })
    const server = createServer((req, res) => {
      if (holdNextRequest) {
        holdNextRequest = false
        onCancelHeld()
        void cancelGate.promise.then(() => workerHandler(req, res))
        return
      }
      void workerHandler(req, res)
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-retry-race-'))
    homes.push(home)
    const runtime = runtimeFor(home, holdingModel(new Map()))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    // Occupy the only local slot so placement must choose the remote node.
    expect(runtime.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtime, 'cancel_retry_race')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    const current = loadTicket(runtime, ticketId)
    const armed = current.assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // End the armed Assignment through the normal report path. `onAssignmentEnded`
    // queues the cancel/release microtask, which starts a releasing cancel only
    // after it re-reads the Ticket and sees no replacement yet.
    holdNextRequest = true
    const failed = runtime.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    expect(failed.surfaced).toBe(false)

    // The default cancel path is now in flight and parked at the inbox.
    await cancelHeld

    // A genuine relaunch runs before that cancel settles. The sticky remote
    // reservation is still present, so the retry is placed and dispatched to
    // the same node while the old cancel is still awaiting its response.
    await runtime.retry(ticketId)
    await waitFor(
      () => assignments.some(
        event => event.ticketId === ticketId
          && (event.assignment as { id?: string } | undefined)?.id !== armed.id,
      ),
      5_000,
      'retry Assignment to reach the remote inbox',
    )
    const replaced = loadTicket(runtime, ticketId)
    const replacement = replaced.assignments.at(-1)!
    expect(replacement.id).not.toBe(armed.id)
    expect(replacement.state).toBe('running')
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(true)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    // Let the in-flight cancel settle now that the replacement owns the slot.
    cancelGate.release()

    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId),
      5_000,
      'inbox to receive the cancel for the ended Assignment',
    )
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote cancel kept slot ticketId=${ticketId} assignmentId=${armed.id} replacementId=${replacement.id} reason=live-replacement`,
      ),
      5_000,
      'settled cancel to keep the retry replacement slot',
    )

    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacement.id)
    expect(latest.state).toBe('running')
    expect(latest.report).toBeUndefined()
    expect(after.ended).toBeUndefined()
    // The cancel still targets the ended Assignment, not the retry.
    expect(cancels.find(event => event.ticketId === ticketId)?.assignmentId).toBe(armed.id)
    // The settled cancel must not steal the retry replacement's mesh capacity.
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(true)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    // The wait was re-armed for the live replacement.
    expect(runtime.log.text()).toContain(
      `[mesh] remote result wait armed ticketId=${ticketId} assignmentId=${replacement.id}`,
    )

    await shutdown(runtime)
  }, 60_000)

  it('cancels the ended remote Assignment when recovery releases a pending replacement', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
      onAssignment: (event) => {
        assignments.push(event)
        return undefined
      },
      onAssignmentCancel: (event) => {
        cancels.push(event)
        return undefined
      },
    })
    const server = createServer(workerHandler)
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-recovery-target-'))
    homes.push(home)
    const runtime = runtimeFor(home, holdingModel(new Map()))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    // Occupy the only local slot so placement must choose the remote node.
    expect(runtime.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtime, 'cancel_recovery_target')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    const armed = loadTicket(runtime, ticketId).assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // Real restart recovery ends the running Assignment, appends a pending
    // replacement, and queues the release microtask. The pending replacement is
    // visible before `releaseSlot` starts and is deliberately not live.
    const recovered = runtime.engine.recoverInterrupted()
    expect(recovered.map(item => item.ticketId)).toContain(ticketId)
    const afterRecovery = loadTicket(runtime, ticketId)
    const ended = afterRecovery.assignments.find(item => item.id === armed.id)!
    expect(ended.state).toBe('ended')
    const replacement = afterRecovery.assignments.at(-1)!
    expect(replacement.id).not.toBe(armed.id)
    expect(replacement.state).toBe('pending')
    expect(replacement.node).toBeUndefined()
    expect(replacement.startedAt).toBeUndefined()

    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId),
      5_000,
      'inbox to receive the cancel for the ended Assignment',
    )
    // The unplaced pending replacement is not live, so the sticky slot is
    // conservatively released after the cancel settles.
    await waitFor(
      () => runtime.placement.remote?.hasTicketAssignment(ticketId) === false,
      5_000,
      'sticky remote slot to be released',
    )
    await waitFor(
      () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
      5_000,
      'remote capacity to be released',
    )

    // The authenticated cancel must target the Assignment that ran on the
    // worker, not the pending replacement the worker never received.
    const cancel = cancels.find(event => event.ticketId === ticketId)
    expect(cancel?.assignmentId).toBe(armed.id)
    expect(cancel?.assignmentId).not.toBe(replacement.id)

    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacement.id)
    expect(latest.state).toBe('pending')
    expect(after.ended).toBeUndefined()

    await shutdown(runtime)
  }, 60_000)

  it('cancels the ended remote Assignment after a process restart', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
      onAssignment: (event) => {
        assignments.push(event)
        return undefined
      },
      onAssignmentCancel: (event) => {
        cancels.push(event)
        return undefined
      },
    })
    const server = createServer(workerHandler)
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-process-restart-'))
    homes.push(home)
    const node = {
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    }

    // Runtime A: place the ticket on the remote peer and leave it running there.
    const runtimeA = runtimeFor(home, holdingModel(new Map()))
    runtimeA.placement.registerRemoteNode(node)
    runtimeA.start({ assessPending: false })
    // Occupy the only local slot so placement must choose the remote node.
    expect(runtimeA.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtimeA, 'cancel_process_restart')
    await runtimeA.harness.launch(loadTicket(runtimeA, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    const armed = loadTicket(runtimeA, ticketId).assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')
    expect(runtimeA.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    // The worker accepted the Assignment and never returned a result.
    expect(cancels).toHaveLength(0)

    // Crash the host without cancelling: stop the daemon and close SQLite while
    // the remote worker still runs the accepted Assignment.
    runtimeA.daemon.stop()
    runtimeA.store.close()
    expect(cancels).toHaveLength(0)

    // Runtime B: the production restart path. A fresh process has an empty
    // sticky map, so recovery must rebuild it from the persisted Assignment
    // node before ending the running Assignment.
    const runtimeB = runtimeFor(home, holdingModel(new Map()))
    runtimeB.placement.registerRemoteNode(node)
    runtimeB.start({ assessPending: false })

    const recovered = loadTicket(runtimeB, ticketId)
    const ended = recovered.assignments.find(item => item.id === armed.id)!
    expect(ended.state).toBe('ended')
    const replacement = recovered.assignments.at(-1)!
    expect(replacement.id).not.toBe(armed.id)
    expect(['pending', 'running']).toContain(replacement.state)

    // The required result: the restarted host tells the worker to stop the
    // Assignment that actually ran. A2 may still be pending or already
    // dispatched, so only A1's cancel is asserted.
    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId),
      5_000,
      'inbox to receive the cancel for the interrupted Assignment',
    )
    const cancel = cancels.find(event => event.ticketId === ticketId)
    expect(cancel?.assignmentId).toBe(armed.id)
    expect(cancel?.assignmentId).not.toBe(replacement.id)
    // The cancel was only possible because recovery rebuilt the sticky
    // reservation from persisted state before `releaseSlot` ran.
    expect(runtimeB.log.text()).toContain(
      `[recovery] remote reservation restored ticketId=${ticketId} assignmentId=${armed.id} node=${REMOTE_NODE_ID}`,
    )

    await shutdown(runtimeB)
  }, 60_000)

  it('cancels an ended remote Assignment left behind by a mid-recovery crash', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
      onAssignment: (event) => {
        assignments.push(event)
        return undefined
      },
      onAssignmentCancel: (event) => {
        cancels.push(event)
        return undefined
      },
    })
    const server = createServer(workerHandler)
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-mid-recovery-'))
    homes.push(home)
    const node = {
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    }

    // Runtime A: dispatch a running remote Assignment. The worker accepts it
    // and never returns a result.
    const runtimeA = runtimeFor(home, holdingModel(new Map()))
    runtimeA.placement.registerRemoteNode(node)
    runtimeA.start({ assessPending: false })
    expect(runtimeA.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtimeA, 'cancel_mid_recovery')
    await runtimeA.harness.launch(loadTicket(runtimeA, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    const armed = loadTicket(runtimeA, ticketId).assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // Host crash without a cancel.
    runtimeA.daemon.stop()
    runtimeA.store.close()
    expect(cancels).toHaveLength(0)

    // Runtime B: the production restart path commits recovery (A1 ended, one
    // pending replacement, RECOVERED input) and queues `releaseSlot` as a
    // microtask. Crash synchronously after `start()` returns, before that
    // microtask can send the cancel, while the worker still holds A1.
    const runtimeB = runtimeFor(home, holdingModel(new Map()))
    runtimeB.placement.registerRemoteNode(node)
    runtimeB.start({ assessPending: false })

    const recoveredB = loadTicket(runtimeB, ticketId)
    const ended = recoveredB.assignments.find(item => item.id === armed.id)!
    expect(ended.state).toBe('ended')
    const replacement = recoveredB.assignments.at(-1)!
    expect(replacement.id).not.toBe(armed.id)
    expect(replacement.state).toBe('pending')

    runtimeB.daemon.stop()
    runtimeB.store.close()
    // Let B's queued microtask run against the closed store so it cannot
    // deliver a cancel for A1.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(cancels).toHaveLength(0)

    // Runtime C: recovery finds no running Assignment (A1 is already ended and
    // the replacement is still pending), so it only relaunches A2. It must
    // still rebuild sticky from the ended remote predecessor and send A1's
    // cancel before (or while) A2 is dispatched to the same worker.
    const runtimeC = runtimeFor(home, holdingModel(new Map()))
    runtimeC.placement.registerRemoteNode(node)
    runtimeC.start({ assessPending: false })

    expect(runtimeC.log.text()).toContain(
      `[recovery] remote reservation restored ticketId=${ticketId} assignmentId=${armed.id} node=${REMOTE_NODE_ID} state=ended`,
    )

    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId),
      5_000,
      'inbox to receive the leftover cancel for the ended Assignment',
    )
    const cancel = cancels.find(event => event.ticketId === ticketId)
    expect(cancel?.assignmentId).toBe(armed.id)
    expect(cancel?.assignmentId).not.toBe(replacement.id)

    // A2 may be pending or already dispatched; either way A1 is not left
    // running on the worker uncancelled.
    await waitFor(
      () => assignments.some(event =>
        (event.assignment as { assignmentId?: string } | undefined)?.assignmentId === replacement.id),
      5_000,
      'replacement Assignment to reach the remote inbox',
    )
    const current = loadTicket(runtimeC, ticketId)
    expect(current.assignments.find(item => item.id === armed.id)?.state).toBe('ended')
    expect(cancels.filter(event => event.assignmentId === armed.id)).toHaveLength(1)

    await shutdown(runtimeC)
  }, 60_000)

  it('cancels an older remote Assignment whose cancel was lost before recovery ended its replacement', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
      onAssignment: (event) => {
        assignments.push(event)
        return undefined
      },
      onAssignmentCancel: (event) => {
        cancels.push(event)
        return undefined
      },
    })
    const worker = createServer(workerHandler)
    servers.push(worker)
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject)
      worker.listen(0, '127.0.0.1', () => resolve())
    })
    const workerAddress = worker.address()
    if (typeof workerAddress !== 'object' || workerAddress === null) throw new Error('worker bind failed')
    const proxy = await startCancelDroppingProxy(`http://127.0.0.1:${workerAddress.port}/a2a`)

    // A required capability forces every placement onto this remote node, so a
    // restarted host with a free local slot still dispatches there. The row
    // sequence below is written only by production recovery and launch.
    const REQUIRED_CAPABILITY = 'cancel-lost-worker-only'
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-lost-older-'))
    homes.push(home)
    const node = {
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    }
    const newRuntime = (): Runtime =>
      runtimeFor(home, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)

    // Runtime A: dispatch running remote A1. The worker accepts it and never
    // returns a result; the host crashes without sending a cancel.
    const runtimeA = newRuntime()
    runtimeA.placement.registerRemoteNode(node)
    runtimeA.start({ assessPending: false })

    const ticketId = createTicket(runtimeA, 'cancel_lost_older_predecessor')
    await runtimeA.harness.launch(loadTicket(runtimeA, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'A1 to reach the remote inbox',
    )
    const a1 = loadTicket(runtimeA, ticketId).assignments.at(-1)!
    expect(a1.node).toBe(REMOTE_NODE_ID)
    expect(a1.state).toBe('running')
    expect(runtimeA.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    runtimeA.daemon.stop()
    runtimeA.store.close()
    expect(cancels).toHaveLength(0)

    // Runtime B: production recovery ends A1, appends A2, and dispatches A2 to
    // the same worker. A1's cancel is attempted but the proxy drops it, so the
    // worker never sees it. A2 runs until B crashes.
    proxy.dropping = true
    const runtimeB = newRuntime()
    runtimeB.placement.registerRemoteNode(node)
    runtimeB.start({ assessPending: false })

    const recoveredB = loadTicket(runtimeB, ticketId)
    const a2 = recoveredB.assignments.at(-1)!
    expect(a2.id).not.toBe(a1.id)
    expect(recoveredB.assignments.find(item => item.id === a1.id)?.state).toBe('ended')
    await waitFor(
      () => assignments.some(event => assignmentIdOf(event) === a2.id),
      5_000,
      'A2 to reach the remote inbox',
    )
    await waitFor(
      () => loadTicket(runtimeB, ticketId).assignments
        .some(item => item.id === a2.id && item.state === 'running'),
      5_000,
      'A2 to be persisted as running on the remote node',
    )
    expect(loadTicket(runtimeB, ticketId).assignments.find(item => item.id === a2.id)?.node)
      .toBe(REMOTE_NODE_ID)
    await waitFor(
      () => proxy.dropped.some(item => item.assignmentId === a1.id),
      5_000,
      'B to attempt the lost A1 cancel',
    )
    // The dropped cancel never reached the worker.
    expect(cancels).toHaveLength(0)

    runtimeB.daemon.stop()
    runtimeB.store.close()
    proxy.dropping = false
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(cancels).toHaveLength(0)

    // Runtime C: A2 is persisted running. Recovery ends A2, appends pending A3,
    // and queues `releaseSlot`. Because this `start()` newly ended A2, the
    // leftover-cancel path is skipped; `releaseSlot` itself must still tell the
    // worker to stop every ended remote predecessor, including A1, whose cancel
    // never arrived.
    const runtimeC = newRuntime()
    runtimeC.placement.registerRemoteNode(node)
    runtimeC.start({ assessPending: false })

    const afterC = loadTicket(runtimeC, ticketId)
    expect(afterC.assignments.find(item => item.id === a1.id)?.state).toBe('ended')
    expect(afterC.assignments.find(item => item.id === a2.id)?.state).toBe('ended')
    const a3 = afterC.assignments.at(-1)!
    expect(a3.id).not.toBe(a1.id)
    expect(a3.id).not.toBe(a2.id)
    expect(['pending', 'running']).toContain(a3.state)
    expect(runtimeC.log.text()).toContain(
      `[recovery] relaunch ticketId=${ticketId} interrupted=${a2.id} replacementId=${a3.id} mode=recovered`,
    )

    await waitFor(
      () => cancels.some(event => event.assignmentId === a1.id),
      5_000,
      'worker to receive the lost A1 cancel from the later recovery',
    )
    // A later Assignment is dispatched onto the same worker, but only after A1
    // (and A2) are cancelled: A1 is not left running uncancelled beside it.
    await waitFor(
      () => assignments.some(event => {
        const id = assignmentIdOf(event)
        return id !== a1.id && id !== a2.id
      }),
      5_000,
      'A3 to reach the remote inbox',
    )
    expect(cancels.some(event => event.ticketId === ticketId && event.assignmentId === a1.id)).toBe(true)

    await shutdown(runtimeC)
  }, 60_000)

  it('cancels a lost older remote Assignment when its replacement ends in the same process', async () => {
    const { assignments, cancels, proxy, runtimeB, ticketId, a1, a2 } =
      await setupLostA1ThenRunningA2('failed-report')

    // From here the proxy forwards cancels, so the Worker inbox shows what this
    // process actually sends when A2 ends. Production timeout path: the failed
    // report leaves the Ticket open and ends the latest Assignment (A2) itself.
    proxy.dropping = false
    const reported = runtimeB.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    expect(reported.surfaced).toBe(false)

    const afterReport = loadTicket(runtimeB, ticketId)
    expect(afterReport.ended).toBeUndefined()
    expect(afterReport.assignments.at(-1)?.id).toBe(a2.id)
    expect(afterReport.assignments.at(-1)?.state).toBe('ended')
    expect(afterReport.assignments.find(item => item.id === a1.id)?.state).toBe('ended')

    // `releaseSlot` targets ended A2, but A1's cancel was lost earlier and the
    // Worker may still run it. That older predecessor must be cancelled too,
    // not only the nearest ended row.
    // Both end hooks queue `releaseSlot`, so A1's and A2's cancels are sent
    // concurrently; wait for both before asserting either one arrived.
    await waitFor(
      () => cancels.some(event => event.assignmentId === a1.id)
        && cancels.some(event => event.assignmentId === a2.id),
      5_000,
      'worker to receive the retried A1 cancel and the A2 cancel after A2 ended',
    )
    expect(cancels.some(event => event.assignmentId === a1.id)).toBe(true)
    expect(cancels.some(event => event.assignmentId === a2.id)).toBe(true)

    // A later retry may dispatch A3 onto the same Worker, but A1 must already
    // have been cancelled rather than left running beside it.
    const retried = await runtimeB.retry(ticketId, 'same-process-failed-retry')
    expect(retried).toBeDefined()
    expect(retried?.ended).toBeUndefined()
    const a3 = loadTicket(runtimeB, ticketId).assignments.at(-1)!
    expect(a3.id).not.toBe(a1.id)
    expect(a3.id).not.toBe(a2.id)
    await waitFor(
      () => assignments.some(event => assignmentIdOf(event) === a3.id) || a3.state === 'running',
      5_000,
      'A3 to reach the remote inbox or start running',
    )
    expect(cancels.some(event => event.ticketId === ticketId && event.assignmentId === a1.id)).toBe(true)

    await shutdown(runtimeB)
  }, 60_000)

  it('cancels a lost older remote Assignment when a successful report ends the Ticket', async () => {
    const { cancels, proxy, runtimeB, ticketId, a1, a2 } =
      await setupLostA1ThenRunningA2('ready-report')

    proxy.dropping = false
    const reported = runtimeB.engine.report(ticketId, {
      kind: 'ready',
      text: 'remote done',
      deliver: false,
    })
    expect(reported.surfaced).toBe(false)

    const afterReport = loadTicket(runtimeB, ticketId)
    expect(afterReport.ended).toBeDefined()
    expect(afterReport.assignments.at(-1)?.id).toBe(a2.id)
    expect(afterReport.assignments.at(-1)?.state).toBe('ended')

    // Both end hooks (`onAssignmentEnded`, `onTicketEnded`) may queue
    // `releaseSlot`, so duplicate A2 cancels are fine. The Worker must still
    // receive A1's cancel even though the Ticket is already terminal.
    // Both end hooks queue `releaseSlot`, so A1's and A2's cancels are sent
    // concurrently; wait for both before asserting either one arrived.
    await waitFor(
      () => cancels.some(event => event.assignmentId === a1.id)
        && cancels.some(event => event.assignmentId === a2.id),
      5_000,
      'worker to receive the retried A1 cancel and the A2 cancel after the Ticket ended',
    )
    expect(cancels.filter(event => event.assignmentId === a1.id).length).toBeGreaterThanOrEqual(1)
    expect(cancels.some(event => event.assignmentId === a2.id)).toBe(true)

    await shutdown(runtimeB)
  }, 60_000)

  it('cancels the lost older remote Assignment when the inbound failed result ends the latest one', async () => {
    const { assignments, cancels, proxy, runtimeB, ticketId, a1, a2 } =
      await setupLostA1ThenRunningA2('apply-failed-report')

    // Production inbound path: a Worker posts `assignment_result` and the host
    // applies it here. `engine.report` queues `releaseSlot` as a microtask, but
    // this method used to synchronously clear the sticky reservation right
    // after, so that microtask saw no remote slot and sent no cancel. The
    // Worker would then keep A1 (whose cancel was lost) running while A3 is
    // retried onto it.
    proxy.dropping = false
    runtimeB.applyRemoteAssignmentResult({
      peerId: WORKER_PEER,
      ticketId,
      assignmentId: a2.id,
      report: { kind: 'failed', text: 'remote worker failed', deliver: false },
      deliveryKey: `deliv-apply-failed-${ticketId}-${a2.id}`,
      envelope: { from: WORKER_PEER, to: HOST_PEER, body: {} },
    })

    const afterResult = loadTicket(runtimeB, ticketId)
    expect(afterResult.ended).toBeUndefined()
    expect(afterResult.assignments.at(-1)?.id).toBe(a2.id)
    expect(afterResult.assignments.at(-1)?.state).toBe('ended')
    expect(afterResult.assignments.find(item => item.id === a1.id)?.state).toBe('ended')

    // Both end hooks queue `releaseSlot`, so A1's and A2's cancels are sent
    // concurrently; wait for both before asserting either one arrived.
    await waitFor(
      () => cancels.some(event => event.assignmentId === a1.id)
        && cancels.some(event => event.assignmentId === a2.id),
      5_000,
      'worker to receive the lost A1 cancel and the A2 cancel after the inbound failed result',
    )
    expect(cancels.some(event => event.assignmentId === a1.id)).toBe(true)
    expect(cancels.some(event => event.assignmentId === a2.id)).toBe(true)

    // A retry may dispatch A3 onto the same Worker, but A1 must already have
    // been cancelled rather than left running uncancelled beside it.
    const retried = await runtimeB.retry(ticketId, 'apply-failed-retry')
    expect(retried).toBeDefined()
    expect(retried?.ended).toBeUndefined()
    const a3 = loadTicket(runtimeB, ticketId).assignments.at(-1)!
    expect(a3.id).not.toBe(a1.id)
    expect(a3.id).not.toBe(a2.id)
    await waitFor(
      () => assignments.some(event => assignmentIdOf(event) === a3.id) || a3.state === 'running',
      5_000,
      'A3 to reach the remote inbox or start running',
    )
    expect(cancels.some(event => event.ticketId === ticketId && event.assignmentId === a1.id)).toBe(true)

    await shutdown(runtimeB)
  }, 60_000)

  it('cancels the lost older remote Assignment when the inbound ready result ends the Ticket', async () => {
    const { cancels, proxy, runtimeB, ticketId, a1, a2 } =
      await setupLostA1ThenRunningA2('apply-ready-report')

    proxy.dropping = false
    runtimeB.applyRemoteAssignmentResult({
      peerId: WORKER_PEER,
      ticketId,
      assignmentId: a2.id,
      report: { kind: 'ready', text: 'remote done', deliver: false },
      deliveryKey: `deliv-apply-ready-${ticketId}-${a2.id}`,
      envelope: { from: WORKER_PEER, to: HOST_PEER, body: {} },
    })

    const afterResult = loadTicket(runtimeB, ticketId)
    expect(afterResult.ended).toBeDefined()
    expect(afterResult.assignments.at(-1)?.id).toBe(a2.id)
    expect(afterResult.assignments.at(-1)?.state).toBe('ended')

    // Both end hooks queue `releaseSlot`, so duplicate A2 cancels are fine. The
    // Worker must still receive A1's cancel even though the Ticket is terminal,
    // because the inbound path no longer clears the reservation first.
    await waitFor(
      () => cancels.some(event => event.assignmentId === a1.id)
        && cancels.some(event => event.assignmentId === a2.id),
      5_000,
      'worker to receive the lost A1 cancel and the A2 cancel after the inbound ready result ended the Ticket',
    )
    expect(cancels.filter(event => event.assignmentId === a1.id).length).toBeGreaterThanOrEqual(1)
    expect(cancels.some(event => event.assignmentId === a2.id)).toBe(true)

    // The queued `releaseSlot` still frees the ended Ticket's slot, so capacity
    // does not leak on the successful inbound path.
    await waitFor(
      () => runtimeB.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
      5_000,
      'the ended Ticket slot to be released',
    )

    await shutdown(runtimeB)
  }, 60_000)

  it('cancels a lost older remote Assignment when a crash loses the ended-latest cancels', async () => {
    const { assignments, cancels, proxy, runtimeB, ticketId, a1, a2, node, newRuntime } =
      await setupLostA1ThenRunningA2('failed-report-crash')

    // Production timeout path in process B: the failed report leaves the Ticket
    // open and ends the latest Assignment (A2) itself. 30903c9's `releaseSlot`
    // would cancel A1 and A2, but the process dies in the same turn before the
    // queued microtask can send either.
    const reported = runtimeB.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    expect(reported.surfaced).toBe(false)

    const afterReport = loadTicket(runtimeB, ticketId)
    expect(afterReport.ended).toBeUndefined()
    expect(afterReport.assignments.at(-1)?.id).toBe(a2.id)
    expect(afterReport.assignments.at(-1)?.state).toBe('ended')
    expect(afterReport.assignments.find(item => item.id === a1.id)?.state).toBe('ended')

    runtimeB.daemon.stop()
    runtimeB.store.close()
    // Let B's queued `releaseSlot` microtask run against the closed store. It
    // cannot deliver a cancel, reproducing the crash before the HTTP send.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(cancels).toHaveLength(0)

    // Process C: recovery sees no running Assignment and no pending
    // replacement, so it ends nobody and relaunches nothing. It must still
    // rebuild sticky from the ended remote predecessor and send the lost
    // cancels.
    proxy.dropping = false
    const runtimeC = newRuntime()
    runtimeC.placement.registerRemoteNode(node)
    runtimeC.start({ assessPending: false })

    expect(runtimeC.log.text()).toContain(
      `[recovery] remote reservation restored ticketId=${ticketId} assignmentId=${a1.id} node=${REMOTE_NODE_ID} state=ended`,
    )
    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId && event.assignmentId === a1.id),
      5_000,
      'worker to receive the lost A1 cancel from the restarted host',
    )

    const afterStart = loadTicket(runtimeC, ticketId)
    expect(afterStart.ended).toBeUndefined()
    expect(afterStart.assignments.at(-1)?.id).toBe(a2.id)
    expect(afterStart.assignments.at(-1)?.state).toBe('ended')

    // A later retry may dispatch A3 onto the same Worker; A1 must not still be
    // running uncancelled beside it.
    const retried = await runtimeC.retry(ticketId, 'crash-window-retry')
    expect(retried).toBeDefined()
    expect(retried?.ended).toBeUndefined()
    const a3 = loadTicket(runtimeC, ticketId).assignments.at(-1)!
    expect(a3.id).not.toBe(a1.id)
    expect(a3.id).not.toBe(a2.id)
    await waitFor(
      () => assignments.some(event => assignmentIdOf(event) === a3.id) || a3.state === 'running',
      5_000,
      'A3 to reach the remote inbox or start running',
    )
    expect(cancels.some(event => event.ticketId === ticketId && event.assignmentId === a1.id)).toBe(true)

    await shutdown(runtimeC)
  }, 60_000)

  it('cancels a lost older remote Assignment when a crash loses the terminal Ticket cancels', async () => {
    const { cancels, proxy, runtimeB, ticketId, a1, a2, node, newRuntime } =
      await setupLostA1ThenRunningA2('ready-report-crash')

    // A successful report ends the Ticket and A2. Both end hooks queue
    // `releaseSlot`, but the process dies in the same turn before either
    // microtask can send the lost A1 cancel.
    const reported = runtimeB.engine.report(ticketId, {
      kind: 'ready',
      text: 'remote done',
      deliver: false,
    })
    expect(reported.surfaced).toBe(false)

    const afterReport = loadTicket(runtimeB, ticketId)
    expect(afterReport.ended).toBeDefined()
    expect(afterReport.assignments.at(-1)?.id).toBe(a2.id)
    expect(afterReport.assignments.at(-1)?.state).toBe('ended')

    runtimeB.daemon.stop()
    runtimeB.store.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(cancels).toHaveLength(0)

    // Process C: the Ticket is already terminal, so recovery skips it. The
    // persisted older ended remote row must still trigger the lost A1 cancel.
    proxy.dropping = false
    const runtimeC = newRuntime()
    runtimeC.placement.registerRemoteNode(node)
    runtimeC.start({ assessPending: false })

    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId && event.assignmentId === a1.id),
      5_000,
      'worker to receive the lost A1 cancel even though the Ticket is terminal',
    )
    expect(cancels.filter(event => event.assignmentId === a1.id).length).toBeGreaterThanOrEqual(1)
    expect(loadTicket(runtimeC, ticketId).ended).toBeDefined()

    await shutdown(runtimeC)
  }, 60_000)

  it('cancels an A1-only ended remote Assignment when a crash loses the terminal Ticket cancel', async () => {
    const { inbox, runtimeB, ticketId, a1 } =
      await setupA1OnlyEndedRemote('a1-only-ready-crash', 'ready')

    // The Ticket's only Assignment is the ended remote A1 and the successful
    // report already ended the Ticket. There is no superseded predecessor, so
    // the ended latest itself must be the leftover-restore signal.
    expect(runtimeB.log.text()).toContain(
      `[recovery] remote reservation restored ticketId=${ticketId} assignmentId=${a1.id} node=${REMOTE_NODE_ID} state=ended`,
    )
    await waitFor(
      () => inbox.cancels.some(event =>
        event.ticketId === ticketId && event.assignmentId === a1.id),
      5_000,
      'worker to receive the lost A1 cancel for the terminal A1-only Ticket',
    )
    expect(loadTicket(runtimeB, ticketId).ended).toBeDefined()

    // A later Ticket is launched onto the same required-capability node; the
    // required observable is that start() already resends A1's cancel, not a
    // cross-Ticket dispatch order.
    const laterId = createTicket(runtimeB, 'a1-only-ready-crash-later')
    await runtimeB.harness.launch(loadTicket(runtimeB, laterId))
    await waitFor(
      () => inbox.assignments.some(event => event.ticketId === laterId),
      5_000,
      'the later Ticket to reach the remote inbox',
    )
    expect(inbox.cancels.some(event =>
      event.ticketId === ticketId && event.assignmentId === a1.id)).toBe(true)

    await shutdown(runtimeB)
  }, 60_000)

  it('cancels an A1-only ended remote Assignment when a crash loses the failed-report cancel', async () => {
    const { inbox, runtimeB, ticketId, a1 } =
      await setupA1OnlyEndedRemote('a1-only-failed-crash', 'failed')

    // The failed/timeout report left the Ticket open but ended A1, which is the
    // only Assignment. start() must rebuild sticky from it and resend its cancel.
    expect(runtimeB.log.text()).toContain(
      `[recovery] remote reservation restored ticketId=${ticketId} assignmentId=${a1.id} node=${REMOTE_NODE_ID} state=ended`,
    )
    await waitFor(
      () => inbox.cancels.some(event =>
        event.ticketId === ticketId && event.assignmentId === a1.id),
      5_000,
      'worker to receive the lost A1 cancel for the open A1-only Ticket',
    )
    const openAfterStart = loadTicket(runtimeB, ticketId)
    expect(openAfterStart.ended).toBeUndefined()
    expect(openAfterStart.assignments.at(-1)?.id).toBe(a1.id)
    expect(openAfterStart.assignments.at(-1)?.state).toBe('ended')

    // A later retry may dispatch a replacement onto the same Worker, but A1
    // must already be cancelled rather than left running beside it.
    const retried = await runtimeB.retry(ticketId, 'a1-only-failed-crash-retry')
    expect(retried).toBeDefined()
    expect(retried?.ended).toBeUndefined()
    const a2 = loadTicket(runtimeB, ticketId).assignments.at(-1)!
    expect(a2.id).not.toBe(a1.id)
    await waitFor(
      () => inbox.assignments.some(event => assignmentIdOf(event) === a2.id)
        || a2.state === 'running',
      5_000,
      'the retry replacement to reach the remote inbox or start running',
    )
    expect(inbox.cancels.some(event =>
      event.ticketId === ticketId && event.assignmentId === a1.id)).toBe(true)

    await shutdown(runtimeB)
  }, 60_000)

  it('cancels the superseded remote Assignment before dispatching its replacement after recovery', async () => {
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDelayingProxy(inbox.url, 400)

    // The required capability keeps placement remote-only even on a restarted
    // host with a free local slot. Every Ticket row below is written by
    // production recovery / launch, never faked.
    const REQUIRED_CAPABILITY = 'cancel-order-restart'
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-order-restart-'))
    homes.push(home)
    const node = {
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    }
    const newRuntime = (): Runtime =>
      runtimeFor(home, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)

    // Runtime A: dispatch running remote A1, worker accepts it, host crashes
    // without a cancel.
    const runtimeA = newRuntime()
    runtimeA.placement.registerRemoteNode(node)
    runtimeA.start({ assessPending: false })
    const ticketId = createTicket(runtimeA, 'cancel_order_restart')
    await runtimeA.harness.launch(loadTicket(runtimeA, ticketId))
    await waitFor(
      () => inbox.assignments.some(event => event.ticketId === ticketId),
      5_000,
      'A1 to reach the remote inbox',
    )
    const a1 = loadTicket(runtimeA, ticketId).assignments.at(-1)!
    expect(a1.node).toBe(REMOTE_NODE_ID)
    expect(a1.state).toBe('running')
    runtimeA.daemon.stop()
    runtimeA.store.close()
    expect(inbox.cancels).toHaveLength(0)

    // Runtime B: recovery ends A1, appends A2, and must not dispatch A2 until
    // A1's (delayed, not dropped) cancel send has settled.
    proxy.delaying = true
    const runtimeB = newRuntime()
    runtimeB.placement.registerRemoteNode(node)
    runtimeB.start({ assessPending: false })

    const recoveredB = loadTicket(runtimeB, ticketId)
    expect(recoveredB.assignments.find(item => item.id === a1.id)?.state).toBe('ended')
    const a2 = recoveredB.assignments.at(-1)!
    expect(a2.id).not.toBe(a1.id)

    await waitFor(
      () => stampIndex(inbox.stamps, 'cancel', a1.id) >= 0
        && stampIndex(inbox.stamps, 'assignment', a2.id) >= 0,
      10_000,
      'A1 cancel and A2 body to reach the worker',
    )
    const cancelIndex = stampIndex(inbox.stamps, 'cancel', a1.id)
    const replacementIndex = stampIndex(inbox.stamps, 'assignment', a2.id)
    expect(proxy.held.some(item => item.assignmentId === a1.id)).toBe(true)
    // The cancel must be observed no later than the replacement body; a Worker
    // must never hold the superseded A1 beside A2.
    expect(cancelIndex).toBeLessThanOrEqual(replacementIndex)
    expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[replacementIndex].at)

    const current = loadTicket(runtimeB, ticketId)
    expect(current.ended).toBeUndefined()
    expect(current.assignments.find(item => item.id === a1.id)?.state).toBe('ended')
    await shutdown(runtimeB)
  }, 60_000)

  it('cancels the superseded remote Assignment before dispatching its replacement after a mid-recovery crash', async () => {
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDelayingProxy(inbox.url, 400)

    const REQUIRED_CAPABILITY = 'cancel-order-mid-recovery'
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-order-mid-recovery-'))
    homes.push(home)
    const node = {
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    }
    const newRuntime = (): Runtime =>
      runtimeFor(home, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)

    // Runtime A: running remote A1, host crash without a cancel.
    const runtimeA = newRuntime()
    runtimeA.placement.registerRemoteNode(node)
    runtimeA.start({ assessPending: false })
    const ticketId = createTicket(runtimeA, 'cancel_order_mid_recovery')
    await runtimeA.harness.launch(loadTicket(runtimeA, ticketId))
    await waitFor(
      () => inbox.assignments.some(event => event.ticketId === ticketId),
      5_000,
      'A1 to reach the remote inbox',
    )
    const a1 = loadTicket(runtimeA, ticketId).assignments.at(-1)!
    expect(a1.node).toBe(REMOTE_NODE_ID)
    expect(a1.state).toBe('running')
    runtimeA.daemon.stop()
    runtimeA.store.close()
    expect(inbox.cancels).toHaveLength(0)

    // Runtime B: recovery commits A1 ended + pending A2, then the process dies
    // in the same turn before the queued `releaseSlot` can send the cancel.
    const runtimeB = newRuntime()
    runtimeB.placement.registerRemoteNode(node)
    runtimeB.start({ assessPending: false })
    const recoveredB = loadTicket(runtimeB, ticketId)
    expect(recoveredB.assignments.find(item => item.id === a1.id)?.state).toBe('ended')
    const a2 = recoveredB.assignments.at(-1)!
    expect(a2.id).not.toBe(a1.id)
    expect(a2.state).toBe('pending')
    runtimeB.daemon.stop()
    runtimeB.store.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(inbox.cancels).toHaveLength(0)

    // Runtime C: recovery finds only the pending replacement, so it queues the
    // leftover cancel and relaunches A2. With cancel HTTP delayed, A2 must
    // still wait for that leftover cancel send to settle.
    proxy.delaying = true
    const runtimeC = newRuntime()
    runtimeC.placement.registerRemoteNode(node)
    runtimeC.start({ assessPending: false })

    expect(runtimeC.log.text()).toContain(
      `[recovery] remote reservation restored ticketId=${ticketId} assignmentId=${a1.id} node=${REMOTE_NODE_ID} state=ended`,
    )
    await waitFor(
      () => stampIndex(inbox.stamps, 'cancel', a1.id) >= 0
        && stampIndex(inbox.stamps, 'assignment', a2.id) >= 0,
      10_000,
      'leftover A1 cancel and A2 body to reach the worker',
    )
    const cancelIndex = stampIndex(inbox.stamps, 'cancel', a1.id)
    const replacementIndex = stampIndex(inbox.stamps, 'assignment', a2.id)
    expect(proxy.held.some(item => item.assignmentId === a1.id)).toBe(true)
    expect(cancelIndex).toBeLessThanOrEqual(replacementIndex)
    expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[replacementIndex].at)
    expect(inbox.cancels.filter(event => event.assignmentId === a1.id)).toHaveLength(1)

    await shutdown(runtimeC)
  }, 60_000)

  it('cancels an older Ticket before dispatching a later Ticket to the same worker after a crash', async () => {
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDelayingProxy(inbox.url, 400)

    // Capacity 2 is the point of this test: unlike the capacity-1 leftover
    // case, the ended Ticket's sticky reservation does not block a different
    // Ticket from being placed, so only a node-level cancel barrier can stop
    // the later body from overtaking the delayed cancel.
    const REQUIRED_CAPABILITY = 'cancel-cross-ticket-restart'
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-cross-ticket-restart-'))
    homes.push(home)
    const node = {
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 2,
      capabilities: [REQUIRED_CAPABILITY],
    }
    const newRuntime = (): Runtime =>
      runtimeFor(home, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)

    // Runtime A: A1 runs on the required-capability worker, then a production
    // successful report ends A1 and the Ticket. Crash in the same turn so the
    // queued `releaseSlot` never sends A1's cancel.
    const runtimeA = newRuntime()
    runtimeA.placement.registerRemoteNode(node)
    runtimeA.start({ assessPending: false })
    const ticketId = createTicket(runtimeA, 'cancel_cross_ticket_restart')
    await runtimeA.harness.launch(loadTicket(runtimeA, ticketId))
    await waitFor(
      () => inbox.assignments.some(event => event.ticketId === ticketId),
      5_000,
      'A1 to reach the remote inbox',
    )
    const a1 = loadTicket(runtimeA, ticketId).assignments.at(-1)!
    expect(a1.node).toBe(REMOTE_NODE_ID)
    expect(a1.state).toBe('running')
    expect(runtimeA.engine.report(ticketId, {
      kind: 'ready',
      text: 'remote done',
      deliver: false,
    }).surfaced).toBe(false)
    expect(loadTicket(runtimeA, ticketId).ended).toBeDefined()
    runtimeA.daemon.stop()
    runtimeA.store.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(inbox.cancels).toHaveLength(0)

    // Runtime B: start() restores the sticky from ended A1 and queues the
    // leftover cancel. The proxy delays (never drops) its HTTP send.
    proxy.delaying = true
    const runtimeB = newRuntime()
    runtimeB.placement.registerRemoteNode(node)
    runtimeB.start({ assessPending: false })
    expect(runtimeB.log.text()).toContain(
      `[recovery] remote reservation restored ticketId=${ticketId} assignmentId=${a1.id} node=${REMOTE_NODE_ID} state=ended`,
    )
    expect(runtimeB.log.text()).toContain(
      `[recovery] remote cancel queued ticketId=${ticketId} assignmentId=${a1.id} node=${REMOTE_NODE_ID}`,
    )

    // Launch a *different* Ticket immediately, without waiting for A1's cancel
    // to arrive. Its body must wait for that send to settle on the same node.
    const laterId = createTicket(runtimeB, 'cancel_cross_ticket_restart_later')
    await runtimeB.harness.launch(loadTicket(runtimeB, laterId))
    const laterAssignment = loadTicket(runtimeB, laterId).assignments.at(-1)!
    expect(laterAssignment.node).toBe(REMOTE_NODE_ID)
    expect(laterAssignment.state).toBe('running')

    await waitFor(
      () => stampIndex(inbox.stamps, 'cancel', a1.id) >= 0
        && stampIndex(inbox.stamps, 'assignment', laterAssignment.id) >= 0,
      10_000,
      'A1 cancel and the later Ticket body to reach the worker',
    )
    const cancelIndex = stampIndex(inbox.stamps, 'cancel', a1.id)
    const laterIndex = stampIndex(inbox.stamps, 'assignment', laterAssignment.id)
    // The proxy really held A1's cancel rather than dropping it.
    expect(proxy.held.some(item => item.assignmentId === a1.id)).toBe(true)
    // A spare-capacity worker must never hold the ended A1 beside the later
    // Ticket's Assignment: the older Ticket's cancel is observed no later.
    expect(cancelIndex).toBeLessThanOrEqual(laterIndex)
    expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[laterIndex].at)

    await shutdown(runtimeB)
  }, 60_000)

  it('cancels an older Ticket before dispatching a later Ticket to the same worker in the same process', async () => {
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDelayingProxy(inbox.url, 400)

    // Same spare-capacity hole without a restart: a successful report queues
    // A1's cancel, and a later Ticket is launched on the same worker in the
    // same turn. One node-level barrier must cover this path too.
    const REQUIRED_CAPABILITY = 'cancel-cross-ticket-in-process'
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-cross-ticket-in-process-'))
    homes.push(home)
    const node = {
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 2,
      capabilities: [REQUIRED_CAPABILITY],
    }
    const runtime = runtimeFor(home, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)
    runtime.placement.registerRemoteNode(node)
    runtime.start({ assessPending: false })

    const ticketId = createTicket(runtime, 'cancel_cross_ticket_in_process')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => inbox.assignments.some(event => event.ticketId === ticketId),
      5_000,
      'A1 to reach the remote inbox',
    )
    const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
    expect(a1.node).toBe(REMOTE_NODE_ID)
    expect(a1.state).toBe('running')

    // Delay A1's cancel, then end A1 and the Ticket through the production
    // report path. The queued `releaseSlot` send is still in flight when the
    // later Ticket is launched below.
    proxy.delaying = true
    expect(runtime.engine.report(ticketId, {
      kind: 'ready',
      text: 'remote done',
      deliver: false,
    }).surfaced).toBe(false)
    expect(loadTicket(runtime, ticketId).ended).toBeDefined()

    const laterId = createTicket(runtime, 'cancel_cross_ticket_in_process_later')
    await runtime.harness.launch(loadTicket(runtime, laterId))
    const laterAssignment = loadTicket(runtime, laterId).assignments.at(-1)!
    expect(laterAssignment.node).toBe(REMOTE_NODE_ID)
    expect(laterAssignment.state).toBe('running')

    await waitFor(
      () => stampIndex(inbox.stamps, 'cancel', a1.id) >= 0
        && stampIndex(inbox.stamps, 'assignment', laterAssignment.id) >= 0,
      10_000,
      'A1 cancel and the later Ticket body to reach the worker',
    )
    const cancelIndex = stampIndex(inbox.stamps, 'cancel', a1.id)
    const laterIndex = stampIndex(inbox.stamps, 'assignment', laterAssignment.id)
    expect(proxy.held.some(item => item.assignmentId === a1.id)).toBe(true)
    expect(cancelIndex).toBeLessThanOrEqual(laterIndex)
    expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[laterIndex].at)

    await shutdown(runtime)
  }, 60_000)

  it('closes cleanly when finish() shuts SQLite down while a remote cancel is still in flight', async () => {
    const inbox = await startWorkerInbox()
    // Generous delay so the cancel is still in flight when finish() closes the
    // Store even on a loaded CI worker; it is delayed, never dropped.
    const proxy = await startCancelDelayingProxy(inbox.url, 1_500)

    // Production shutdown path: a report ends the remote Assignment and queues
    // a fail-soft `assignment_cancel`; `finish()` then closes SQLite while the
    // delayed send is still in flight. The voided settlement promise used to
    // re-read the Ticket and throw `database is not open`, which Vitest surfaces
    // as an unhandled rejection even though every assertion passed.
    const REQUIRED_CAPABILITY = 'cancel-finish-closed-store'
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-finish-closed-store-'))
    homes.push(home)
    const node = {
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    }
    const runtime = runtimeFor(home, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)
    runtime.placement.registerRemoteNode(node)
    runtime.start({ assessPending: false })

    const ticketId = createTicket(runtime, 'cancel_finish_closed_store')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => inbox.assignments.some(event => event.ticketId === ticketId),
      5_000,
      'A1 to reach the remote inbox',
    )
    const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
    expect(a1.node).toBe(REMOTE_NODE_ID)
    expect(a1.state).toBe('running')

    const rejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      // End the Assignment (and the Ticket) through the production report path;
      // the queued `releaseSlot` sends A1's cancel, which the proxy holds.
      proxy.delaying = true
      expect(runtime.engine.report(ticketId, {
        kind: 'ready',
        text: 'remote done',
        deliver: false,
      }).surfaced).toBe(false)
      await waitFor(
        () => proxy.held.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 cancel send to be in flight at the proxy',
      )

      // Shutdown closes the Store before the delayed cancel settles.
      await runtime.finish()
      expect(runtime.store.isOpen).toBe(false)
      expect(inbox.cancels).toHaveLength(0)

      // The cancel is forwarded and the fail-soft send settles against the
      // now-closed Store. Give Node a turn to emit any unhandled rejection.
      await waitFor(
        () => inbox.cancels.some(event => event.assignmentId === a1.id),
        5_000,
        'the delayed cancel to settle at the worker',
      )
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  }, 60_000)

  it('cancels a superseded remote Assignment on its own node after a lost cancel moved the Ticket', async () => {
    // Two eligible remote workers, both capacity 1 and matching the required
    // capability. N1 is registered first, so placement prefers it.
    const inboxN1 = await startWorkerInbox()
    const inboxN2 = await startWorkerInbox('cancel-pump-worker-2')
    // A cancel-dropping proxy in front of N1 faithfully loses A1's cancel: the
    // send settles (502) but the worker never sees it.
    const proxy = await startCancelDroppingProxy(inboxN1.url)

    const REQUIRED_CAPABILITY = 'cancel-cross-node-routing'
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-cross-node-routing-'))
    homes.push(home)
    const nodeN1 = {
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    }
    const nodeN2 = {
      id: 'cancel-pump-node-2',
      url: inboxN2.url,
      peerId: 'cancel-pump-worker-2',
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    }
    const runtime = runtimeFor(home, holdingModel(new Map()), 60_000, REQUIRED_CAPABILITY)
    runtime.placement.registerRemoteNode(nodeN1)
    runtime.placement.registerRemoteNode(nodeN2)
    runtime.start({ assessPending: false })

    const ticketId = createTicket(runtime, 'cancel_cross_node_routing')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => inboxN1.assignments.some(event => event.ticketId === ticketId),
      5_000,
      'A1 to reach N1',
    )
    const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
    expect(a1.node).toBe(REMOTE_NODE_ID)
    expect(a1.state).toBe('running')

    // Production failed-report path: A1 ends, the Ticket stays open. The proxy
    // answers and drops A1's cancel, so after the failed send settles
    // keep-vs-release conservatively frees T1's N1 sticky slot.
    proxy.dropping = true
    expect(runtime.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker failed',
      deliver: false,
    }).surfaced).toBe(false)
    expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
    await waitFor(
      () => proxy.dropped.some(item => item.assignmentId === a1.id),
      5_000,
      'A1 cancel to be dropped at the N1 proxy',
    )
    expect(inboxN1.cancels).toHaveLength(0)
    await waitFor(
      () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
      5_000,
      'N1 sticky slot to be released after the lost cancel',
    )

    // Occupy N1 with a different Ticket so T1's retry cannot stick there.
    const otherId = createTicket(runtime, 'cancel_cross_node_occupier')
    await runtime.harness.launch(loadTicket(runtime, otherId))
    await waitFor(
      () => inboxN1.assignments.some(event => event.ticketId === otherId),
      5_000,
      'the occupying Ticket to reach N1',
    )
    const other = loadTicket(runtime, otherId).assignments.at(-1)!
    expect(other.node).toBe(REMOTE_NODE_ID)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    // Retry T1 while N1 is full: the replacement is placed on N2, so the
    // Ticket's sticky reservation now differs from A1's recorded node.
    const retried = await runtime.retry(ticketId, 'cross-node-retry')
    expect(retried).toBeDefined()
    await waitFor(
      () => inboxN2.assignments.some(event => event.ticketId === ticketId),
      5_000,
      'A2 to reach N2',
    )
    const a2 = loadTicket(runtime, ticketId).assignments.at(-1)!
    expect(a2.id).not.toBe(a1.id)
    expect(a2.node).toBe('cancel-pump-node-2')
    expect(a2.state).toBe('running')
    expect(loadTicket(runtime, ticketId).assignments.find(item => item.id === a1.id)?.state)
      .toBe('ended')
    expect(runtime.placement.remoteNodeFor(ticketId)).toBe('cancel-pump-node-2')

    // Cancel forwarding is restored. Ending A2 must cancel A2 on N2 *and* the
    // still-held A1 on N1: `assignment_cancel` follows the node recorded on the
    // Assignment, not the Ticket's current sticky reservation.
    proxy.dropping = false
    expect(runtime.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    }).surfaced).toBe(false)

    await waitFor(
      () => inboxN1.cancels.some(event => event.assignmentId === a1.id)
        && inboxN2.cancels.some(event => event.assignmentId === a2.id),
      5_000,
      'A1 cancel to reach N1 and A2 cancel to reach N2',
    )
    // The worker that still held A1 was told to stop it. A1's cancel is not
    // required to reach N2; delivering it there instead is exactly the defect.
    expect(inboxN1.cancels.some(event => event.assignmentId === a1.id)).toBe(true)
    expect(inboxN2.cancels.some(event => event.assignmentId === a2.id)).toBe(true)

    await shutdown(runtime)
  }, 60_000)

  it('cancels a still-held remote Assignment on its own node when the local replacement ends', async () => {
    // One remote worker behind a cancel-dropping proxy. Local mesh capacity is
    // 1, so local-first placement overflows T1 to the remote worker while the
    // only local slot is held.
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDroppingProxy(inbox.url)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-local-replacement-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so T1 has to overflow to the remote worker.
      const blockerId = createTicket(runtime, 'cancel_local_replacement_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const ticketId = createTicket(runtime, 'cancel_local_replacement')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inbox.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Production failed-report path: A1 ends, the Ticket stays open. The
      // proxy answers and drops A1's cancel, so after the failed send settles
      // keep-vs-release conservatively frees T1's remote sticky slot. The
      // worker still holds A1.
      proxy.dropping = true
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote worker failed',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 cancel to be dropped at the N1 proxy',
      )
      expect(inbox.cancels).toHaveLength(0)
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 sticky slot to be released after the lost cancel',
      )
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      // The local overflow is gone: end the holder through the production
      // report path, then let its Worker turn finish so the local slot frees.
      expect(runtime.engine.report(blockerId, {
        kind: 'ready',
        text: 'blocker done',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, blockerId).ended).toBeDefined()
      held.get(blockerId)?.release()
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 0,
        5_000,
        'the local slot to be released after the holder ends',
      )

      // Local-first retry with no required capabilities now places A2 on the
      // host. The Ticket has no remote sticky, and A1 remains ended on N1.
      const retried = await runtime.retry(ticketId, 'local-replacement-retry')
      expect(retried).toBeDefined()
      await waitFor(
        () => loadTicket(runtime, ticketId).assignments.at(-1)?.state === 'running',
        5_000,
        'A2 to be running',
      )
      const a2 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a2.id).not.toBe(a1.id)
      expect(runtime.placement.isRemote(a2.node)).toBe(false)
      expect(a2.node).not.toBe(REMOTE_NODE_ID)
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
      expect(loadTicket(runtime, ticketId).assignments.find(item => item.id === a1.id)?.state)
        .toBe('ended')
      expect(loadTicket(runtime, ticketId).assignments.find(item => item.id === a1.id)?.node)
        .toBe(REMOTE_NODE_ID)

      // Cancel forwarding is restored. Ending the local replacement must still
      // cancel the remote Assignment the worker still holds, even though the
      // Ticket no longer has a remote sticky reservation for it.
      proxy.dropping = false
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'local replacement failed',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).assignments.find(item => item.id === a2.id)?.state)
        .toBe('ended')

      await waitFor(
        () => inbox.cancels.some(event => event.assignmentId === a1.id),
        5_000,
        'A1 cancel to reach N1',
      )
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('cancels a lost remote Assignment before a later Ticket reaches the worker while the local replacement still runs', async () => {
    // Same setup as the 5a703ee local-replacement regression: local capacity
    // is 1, a blocker overflows T1 to the remote worker, A1's cancel is lost so
    // keep-vs-release frees T1's remote sticky, and a local-first retry places
    // A2 on the host. Unlike that case, A2's worker turn stays held, so
    // `releaseSlot` has not run and the 5a703ee backstop cannot help.
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDroppingProxy(inbox.url)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-local-replacement-running-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so T1 has to overflow to the remote worker.
      const blockerId = createTicket(runtime, 'cancel_local_replacement_running_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const ticketId = createTicket(runtime, 'cancel_local_replacement_running')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inbox.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Lose A1's cancel. After the failed send settles keep-vs-release frees
      // T1's remote sticky slot, but the worker still holds A1.
      proxy.dropping = true
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote worker failed',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 sticky slot to be released after the lost cancel',
      )
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      // End the blocker and free the local slot.
      expect(runtime.engine.report(blockerId, {
        kind: 'ready',
        text: 'blocker done',
        deliver: false,
      }).surfaced).toBe(false)
      held.get(blockerId)?.release()
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 0,
        5_000,
        'the local slot to be released after the holder ends',
      )

      // Retry T1 locally but hold A2's worker turn: `releaseSlot` for T1 must
      // not run, so this cannot pass through the 5a703ee backstop.
      held.set(ticketId, gate())
      void runtime.retry(ticketId, 'local-replacement-retry').catch(() => undefined)
      await waitFor(
        () => loadTicket(runtime, ticketId).assignments.at(-1)?.state === 'running',
        5_000,
        'A2 to be running',
      )
      const a2 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a2.id).not.toBe(a1.id)
      expect(runtime.placement.isRemote(a2.node)).toBe(false)
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      // Local placement starts A1's cancel immediately, but forwarding is
      // still off: wait until that second attempt is also dropped, so the
      // later delivery cannot come from the placement send. Without this wait
      // the send can race `proxy.dropping = false` and the test would pass
      // even without a dispatch-time re-send.
      await waitFor(
        () => proxy.dropped.filter(item => item.assignmentId === a1.id).length >= 2,
        5_000,
        'the local-placement A1 cancel to be dropped at the N1 proxy',
      )
      expect(inbox.cancels.some(event => event.assignmentId === a1.id)).toBe(false)

      // Restore forwarding while A2 still runs, then overflow a later Ticket
      // to N1. The later body must not reach the worker before A1's cancel,
      // even though both earlier cancel attempts were lost.
      proxy.dropping = false
      const laterId = createTicket(runtime, 'cancel_local_replacement_running_later')
      await runtime.harness.launch(loadTicket(runtime, laterId))
      const laterAssignment = loadTicket(runtime, laterId).assignments.at(-1)!
      expect(laterAssignment.node).toBe(REMOTE_NODE_ID)

      // Wait for both arrivals; asserting after only one would race.
      await waitFor(
        () => stampIndex(inbox.stamps, 'cancel', a1.id) >= 0
          && stampIndex(inbox.stamps, 'assignment', laterAssignment.id) >= 0,
        10_000,
        'A1 cancel and the later Ticket body to reach the worker',
      )
      const cancelIndex = stampIndex(inbox.stamps, 'cancel', a1.id)
      const laterIndex = stampIndex(inbox.stamps, 'assignment', laterAssignment.id)
      expect(cancelIndex).toBeLessThanOrEqual(laterIndex)
      expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[laterIndex].at)

      // Still the while-running gap: A2 is the running local replacement and
      // T1 has no remote sticky.
      expect(loadTicket(runtime, ticketId).assignments.find(item => item.id === a2.id)?.state)
        .toBe('running')
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('keeps a lost cancel for its own node when a later Ticket overflows to a different node', async () => {
    // Same local-replacement-while-running setup as the 6f4ae79 regression,
    // plus a second remote node. A dispatch-time resend must not consume T1's
    // orphan record when the dispatching Ticket lands on a *different* node
    // than the Worker that still holds A1: otherwise a later Ticket can reach
    // N1 without ever cancelling the historical Assignment.
    const inboxN1 = await startWorkerInbox()
    const inboxN2 = await startWorkerInbox('cancel-pump-worker-2')
    const proxy = await startCancelDroppingProxy(inboxN1.url)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-orphan-wrong-node-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.placement.registerRemoteNode({
      id: 'cancel-pump-node-2',
      url: inboxN2.url,
      peerId: 'cancel-pump-worker-2',
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so T1 has to overflow to N1.
      const blockerId = createTicket(runtime, 'cancel_orphan_wrong_node_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const ticketId = createTicket(runtime, 'cancel_orphan_wrong_node')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inboxN1.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Lose A1's failed-report cancel. After the failed send settles
      // keep-vs-release frees T1's remote sticky slot; the worker still holds
      // A1.
      proxy.dropping = true
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote worker failed',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 sticky slot to be released after the lost cancel',
      )
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      // End the blocker and free the local slot.
      expect(runtime.engine.report(blockerId, {
        kind: 'ready',
        text: 'blocker done',
        deliver: false,
      }).surfaced).toBe(false)
      held.get(blockerId)?.release()
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 0,
        5_000,
        'the local slot to be released after the holder ends',
      )

      // Retry T1 locally but hold A2's worker turn so `releaseSlot` for T1
      // never runs. Snapshot the drop count first: the local-placement send
      // must be a *new* drop, not the failed-report one.
      const droppedBeforeRetry = proxy.dropped
        .filter(item => item.assignmentId === a1.id).length
      held.set(ticketId, gate())
      void runtime.retry(ticketId, 'local-replacement-retry').catch(() => undefined)
      await waitFor(
        () => loadTicket(runtime, ticketId).assignments.at(-1)?.state === 'running',
        5_000,
        'A2 to be running',
      )
      const a2 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a2.id).not.toBe(a1.id)
      expect(runtime.placement.isRemote(a2.node)).toBe(false)
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      await waitFor(
        () => proxy.dropped.filter(item => item.assignmentId === a1.id).length
          > droppedBeforeRetry,
        5_000,
        'the local-placement A1 cancel to be dropped at the N1 proxy',
      )
      expect(inboxN1.cancels.some(event => event.assignmentId === a1.id)).toBe(false)

      // Restore forwarding, then take N1 offline so the next Ticket overflows
      // to N2. That dispatch must leave T1's orphan record intact because A1
      // lives on N1, not N2.
      proxy.dropping = false
      const remote = runtime.placement.remote
      if (!remote) throw new Error('expected a remote mesh registry')
      expect(remote.markOffline(REMOTE_NODE_ID)).toBe(true)

      const divertId = createTicket(runtime, 'cancel_orphan_wrong_node_divert')
      await runtime.harness.launch(loadTicket(runtime, divertId))
      await waitFor(
        () => inboxN2.assignments.some(event => event.ticketId === divertId),
        5_000,
        'the diverting Ticket to reach N2',
      )
      const divert = loadTicket(runtime, divertId).assignments.at(-1)!
      expect(divert.node).toBe('cancel-pump-node-2')
      expect(inboxN1.cancels.some(event => event.assignmentId === a1.id)).toBe(false)

      // Bring N1 back and overflow a later Ticket there. The kept record must
      // re-send A1's cancel, and the body must wait for it.
      expect(remote.heartbeat(REMOTE_NODE_ID)).toBe(true)

      const laterId = createTicket(runtime, 'cancel_orphan_wrong_node_later')
      await runtime.harness.launch(loadTicket(runtime, laterId))
      const later = loadTicket(runtime, laterId).assignments.at(-1)!
      expect(later.node).toBe(REMOTE_NODE_ID)

      // Wait for both arrivals; asserting after only one would race.
      await waitFor(
        () => stampIndex(inboxN1.stamps, 'cancel', a1.id) >= 0
          && stampIndex(inboxN1.stamps, 'assignment', later.id) >= 0,
        10_000,
        'A1 cancel and the later Ticket body to reach N1',
      )
      const cancelIndex = stampIndex(inboxN1.stamps, 'cancel', a1.id)
      const laterIndex = stampIndex(inboxN1.stamps, 'assignment', later.id)
      expect(cancelIndex).toBeLessThanOrEqual(laterIndex)
      expect(inboxN1.stamps[cancelIndex].at).toBeLessThanOrEqual(inboxN1.stamps[laterIndex].at)

      // Still the while-running gap: A2 is the running local replacement and
      // T1 has no remote sticky.
      expect(loadTicket(runtime, ticketId).assignments.find(item => item.id === a2.id)?.state)
        .toBe('running')
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('keeps a lost same-node resend until a further later Ticket reaches the worker', async () => {
    // Same local-replacement-while-running setup as the 6f4ae79 regression, but
    // N1 has capacity 2. The first later Ticket triggers a dispatch-time resend
    // that is itself lost; consuming the orphan record there would let a
    // *further* later Ticket reach N1 while A2 still runs with no cancel queued.
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDroppingProxy(inbox.url)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-orphan-lost-resend-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 2,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so T1 has to overflow to N1.
      const blockerId = createTicket(runtime, 'cancel_orphan_lost_resend_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const ticketId = createTicket(runtime, 'cancel_orphan_lost_resend')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inbox.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Lose A1's failed-report cancel. After the failed send settles
      // keep-vs-release frees T1's remote sticky slot; the worker still holds A1.
      proxy.dropping = true
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote worker failed',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 sticky slot to be released after the lost cancel',
      )
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      // End the blocker and free the local slot.
      expect(runtime.engine.report(blockerId, {
        kind: 'ready',
        text: 'blocker done',
        deliver: false,
      }).surfaced).toBe(false)
      held.get(blockerId)?.release()
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 0,
        5_000,
        'the local slot to be released after the holder ends',
      )

      // Retry T1 locally but hold A2's worker turn so `releaseSlot` for T1
      // never runs. Snapshot the drop count first: the local-placement send
      // must be a *new* drop, not the failed-report one.
      const droppedBeforeRetry = proxy.dropped
        .filter(item => item.assignmentId === a1.id).length
      held.set(ticketId, gate())
      void runtime.retry(ticketId, 'local-replacement-retry').catch(() => undefined)
      await waitFor(
        () => loadTicket(runtime, ticketId).assignments.at(-1)?.state === 'running',
        5_000,
        'A2 to be running',
      )
      const a2 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a2.id).not.toBe(a1.id)
      expect(runtime.placement.isRemote(a2.node)).toBe(false)
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      await waitFor(
        () => proxy.dropped.filter(item => item.assignmentId === a1.id).length
          > droppedBeforeRetry,
        5_000,
        'the local-placement A1 cancel to be dropped at the N1 proxy',
      )
      expect(inbox.cancels.some(event => event.assignmentId === a1.id)).toBe(false)

      // Keep dropping. The first later Ticket overflows onto N1's spare
      // capacity and triggers a same-node dispatch-time resend that is also
      // lost. Snapshot first so we wait for a new drop.
      const droppedBeforeFirstLater = proxy.dropped
        .filter(item => item.assignmentId === a1.id).length
      const firstLaterId = createTicket(runtime, 'cancel_orphan_lost_resend_first_later')
      await runtime.harness.launch(loadTicket(runtime, firstLaterId))
      await waitFor(
        () => inbox.assignments.some(event => event.ticketId === firstLaterId),
        5_000,
        'the first later Ticket to reach N1',
      )
      const firstLater = loadTicket(runtime, firstLaterId).assignments.at(-1)!
      expect(firstLater.node).toBe(REMOTE_NODE_ID)
      await waitFor(
        () => proxy.dropped.filter(item => item.assignmentId === a1.id).length
          > droppedBeforeFirstLater,
        5_000,
        'the same-node dispatch-time A1 cancel to be dropped at the N1 proxy',
      )
      // Lost resend must not reach the worker and must not consume the record.
      expect(inbox.cancels.some(event => event.assignmentId === a1.id)).toBe(false)
      expect(loadTicket(runtime, ticketId).assignments.find(item => item.id === a2.id)?.state)
        .toBe('running')
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      // Restore forwarding. The further later Ticket overflows onto the
      // remaining N1 capacity; the kept record must re-send A1's cancel, and
      // its body must wait for it.
      proxy.dropping = false
      const laterId = createTicket(runtime, 'cancel_orphan_lost_resend_further_later')
      await runtime.harness.launch(loadTicket(runtime, laterId))
      const later = loadTicket(runtime, laterId).assignments.at(-1)!
      expect(later.node).toBe(REMOTE_NODE_ID)

      // Wait for both arrivals; asserting after only one would race.
      await waitFor(
        () => stampIndex(inbox.stamps, 'cancel', a1.id) >= 0
          && stampIndex(inbox.stamps, 'assignment', later.id) >= 0,
        10_000,
        'A1 cancel and the further later Ticket body to reach N1',
      )
      const cancelIndex = stampIndex(inbox.stamps, 'cancel', a1.id)
      const laterIndex = stampIndex(inbox.stamps, 'assignment', later.id)
      expect(cancelIndex).toBeLessThanOrEqual(laterIndex)
      expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[laterIndex].at)

      // Still the while-running gap: A2 is the running local replacement and
      // T1 has no remote sticky.
      expect(loadTicket(runtime, ticketId).assignments.find(item => item.id === a2.id)?.state)
        .toBe('running')
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('keeps an orphan record for another node after a successful same-node resend', async () => {
    // A Ticket can have ended remotes on more than one node. A1 (N1) and A2
    // (N2) both lost their cancels, and a local A3 still runs. When a later
    // Ticket reaches N1 and its dispatch-time resend of A1 *succeeds*, the
    // orphan record must survive: a further later Ticket on N2 still has to
    // resend A2 before its body reaches the Worker that holds it.
    const inboxN1 = await startWorkerInbox()
    const inboxN2 = await startWorkerInbox('cancel-pump-worker-2')
    const proxyN1 = await startCancelDroppingProxy(inboxN1.url)
    const proxyN2 = await startCancelDroppingProxy(inboxN2.url)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-orphan-multi-node-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxyN1.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.placement.registerRemoteNode({
      id: 'cancel-pump-node-2',
      url: proxyN2.url,
      peerId: 'cancel-pump-worker-2',
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so T1 has to overflow to N1.
      const blockerId = createTicket(runtime, 'cancel_orphan_multi_node_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const ticketId = createTicket(runtime, 'cancel_orphan_multi_node')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inboxN1.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Lose A1's failed-report cancel. After the failed send settles
      // keep-vs-release frees T1's N1 sticky slot; the worker still holds A1.
      proxyN1.dropping = true
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote worker failed',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
      await waitFor(
        () => proxyN1.dropped.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 sticky slot to be released after the lost cancel',
      )
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      // Occupy N1 so the retry cannot stick there and must overflow to N2.
      const occupierId = createTicket(runtime, 'cancel_orphan_multi_node_occupier')
      await runtime.harness.launch(loadTicket(runtime, occupierId))
      await waitFor(
        () => inboxN1.assignments.some(event => event.ticketId === occupierId),
        5_000,
        'the occupier to reach N1',
      )
      expect(loadTicket(runtime, occupierId).assignments.at(-1)?.node).toBe(REMOTE_NODE_ID)

      // Retry T1 onto N2 and lose A2's failed-report cancel. `releaseSlot` also
      // re-attempts the historical A1 cancel on N1; both sends are dropped.
      const droppedA1BeforeA2 = proxyN1.dropped
        .filter(item => item.assignmentId === a1.id).length
      proxyN2.dropping = true
      await runtime.retry(ticketId, 'remote-n2-retry')
      await waitFor(
        () => inboxN2.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A2 to reach N2',
      )
      const a2 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a2.id).not.toBe(a1.id)
      expect(a2.node).toBe('cancel-pump-node-2')
      expect(a2.state).toBe('running')
      expect(runtime.placement.remoteNodeFor(ticketId)).toBe('cancel-pump-node-2')

      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote worker failed again',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
      await waitFor(
        () => proxyN2.dropped.some(item => item.assignmentId === a2.id)
          && proxyN1.dropped.filter(item => item.assignmentId === a1.id).length > droppedA1BeforeA2,
        5_000,
        'A2 and the historical A1 cancels to be dropped',
      )
      expect(inboxN2.cancels.some(event => event.assignmentId === a2.id)).toBe(false)
      await waitFor(
        () => !runtime.placement.remoteHasTicket(ticketId),
        5_000,
        'the T1 sticky to be released after the lost A2 cancel',
      )

      // Free the local slot and retry T1 locally. Hold A3's worker turn so
      // `releaseSlot` for T1 cannot run yet.
      expect(runtime.engine.report(blockerId, {
        kind: 'ready',
        text: 'blocker done',
        deliver: false,
      }).surfaced).toBe(false)
      held.get(blockerId)?.release()
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 0,
        5_000,
        'the local slot to be released after the holder ends',
      )

      const droppedA1BeforeLocal = proxyN1.dropped
        .filter(item => item.assignmentId === a1.id).length
      const droppedA2BeforeLocal = proxyN2.dropped
        .filter(item => item.assignmentId === a2.id).length
      held.set(ticketId, gate())
      void runtime.retry(ticketId, 'local-replacement-retry').catch(() => undefined)
      await waitFor(
        () => {
          const latest = loadTicket(runtime, ticketId).assignments.at(-1)
          return latest !== undefined
            && latest.id !== a1.id
            && latest.id !== a2.id
            && latest.state === 'running'
        },
        5_000,
        'A3 to be running as the local replacement',
      )
      const a3 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a3.id).not.toBe(a1.id)
      expect(a3.id).not.toBe(a2.id)
      expect(runtime.placement.isRemote(a3.node)).toBe(false)
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      // Placement-time cancels for both historical Assignments are lost.
      await waitFor(
        () => proxyN1.dropped.filter(item => item.assignmentId === a1.id).length
          > droppedA1BeforeLocal
          && proxyN2.dropped.filter(item => item.assignmentId === a2.id).length
            > droppedA2BeforeLocal,
        5_000,
        'the placement-time A1 and A2 cancels to be dropped',
      )
      expect(inboxN1.cancels.some(event => event.assignmentId === a1.id)).toBe(false)
      expect(inboxN2.cancels.some(event => event.assignmentId === a2.id)).toBe(false)

      // Free N1 and restore its forwarding. The first later Ticket overflows to
      // N1, and its dispatch-time resend of A1 succeeds.
      expect(runtime.engine.report(occupierId, {
        kind: 'ready',
        text: 'occupier done',
        deliver: false,
      }).surfaced).toBe(false)
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 slot to be released after the occupier ends',
      )
      proxyN1.dropping = false

      const laterN1Id = createTicket(runtime, 'cancel_orphan_multi_node_later_n1')
      await runtime.harness.launch(loadTicket(runtime, laterN1Id))
      const laterN1 = loadTicket(runtime, laterN1Id).assignments.at(-1)!
      expect(laterN1.node).toBe(REMOTE_NODE_ID)

      // Wait for both arrivals; asserting after only one would race.
      await waitFor(
        () => stampIndex(inboxN1.stamps, 'cancel', a1.id) >= 0
          && stampIndex(inboxN1.stamps, 'assignment', laterN1.id) >= 0,
        10_000,
        'A1 cancel and the later N1 Ticket body to reach N1',
      )

      // Restore N2 forwarding. The further later Ticket overflows to N2; the
      // kept orphan record must re-send A2 before its body reaches the Worker.
      proxyN2.dropping = false
      const laterN2Id = createTicket(runtime, 'cancel_orphan_multi_node_later_n2')
      await runtime.harness.launch(loadTicket(runtime, laterN2Id))
      const laterN2 = loadTicket(runtime, laterN2Id).assignments.at(-1)!
      expect(laterN2.node).toBe('cancel-pump-node-2')

      // Wait for both arrivals; asserting after only one would race.
      await waitFor(
        () => stampIndex(inboxN2.stamps, 'cancel', a2.id) >= 0
          && stampIndex(inboxN2.stamps, 'assignment', laterN2.id) >= 0,
        10_000,
        'A2 cancel and the further later N2 Ticket body to reach N2',
      )
      const cancelIndex = stampIndex(inboxN2.stamps, 'cancel', a2.id)
      const bodyIndex = stampIndex(inboxN2.stamps, 'assignment', laterN2.id)
      expect(cancelIndex).toBeLessThanOrEqual(bodyIndex)
      expect(inboxN2.stamps[cancelIndex].at).toBeLessThanOrEqual(inboxN2.stamps[bodyIndex].at)

      // Still the while-running gap: A3 is the local replacement and T1 has no
      // remote sticky.
      expect(loadTicket(runtime, ticketId).assignments.find(item => item.id === a3.id)?.state)
        .toBe('running')
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('keeps a lost last-attempt cancel after the local replacement ends', async () => {
    // One remote worker behind a cancel-dropping proxy, local mesh capacity 1.
    // A1 overflows to N1, loses its failed-report cancel and T1's remote sticky
    // is released. A local-first retry places A2 on the host; its placement-time
    // A1 cancel is lost too. Then A2 ends through the production failed-report
    // path while forwarding is still off: `releaseSlot` starts the last-attempt
    // A1 cancel and that send is lost as well. Consuming the orphan record there
    // would leave no resend path, so a later Ticket reaching N1 would find the
    // Worker still holding A1.
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDroppingProxy(inbox.url)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-lost-last-attempt-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so T1 has to overflow to N1.
      const blockerId = createTicket(runtime, 'cancel_lost_last_attempt_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const ticketId = createTicket(runtime, 'cancel_lost_last_attempt')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inbox.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Lose A1's failed-report cancel. After the failed send settles
      // keep-vs-release frees T1's remote sticky slot; the worker holds A1.
      proxy.dropping = true
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote worker failed',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 sticky slot to be released after the lost cancel',
      )
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      // End the blocker and free the local slot.
      expect(runtime.engine.report(blockerId, {
        kind: 'ready',
        text: 'blocker done',
        deliver: false,
      }).surfaced).toBe(false)
      held.get(blockerId)?.release()
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 0,
        5_000,
        'the local slot to be released after the holder ends',
      )

      // Local-first retry places A2 on the host. Hold A2's worker turn so
      // `releaseSlot` does not run yet, then wait for the placement-time A1
      // cancel to be dropped as well.
      const droppedBeforeRetry = proxy.dropped
        .filter(item => item.assignmentId === a1.id).length
      held.set(ticketId, gate())
      void runtime.retry(ticketId, 'local-replacement-retry').catch(() => undefined)
      await waitFor(
        () => loadTicket(runtime, ticketId).assignments.at(-1)?.state === 'running',
        5_000,
        'A2 to be running',
      )
      const a2 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a2.id).not.toBe(a1.id)
      expect(runtime.placement.isRemote(a2.node)).toBe(false)
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      await waitFor(
        () => proxy.dropped.filter(item => item.assignmentId === a1.id).length
          > droppedBeforeRetry,
        5_000,
        'the local-placement A1 cancel to be dropped at the N1 proxy',
      )
      expect(inbox.cancels.some(event => event.assignmentId === a1.id)).toBe(false)

      // Still forwarding off: end A2 through the production failed-report path
      // and release its worker turn so `releaseSlot` runs. Its last-attempt A1
      // cancel is dropped too, which is exactly the attempt that used to consume
      // the orphan record.
      const droppedBeforeRelease = proxy.dropped
        .filter(item => item.assignmentId === a1.id).length
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'local replacement failed',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).assignments.find(item => item.id === a2.id)?.state)
        .toBe('ended')
      held.get(ticketId)?.release()
      await waitFor(
        () => proxy.dropped.filter(item => item.assignmentId === a1.id).length
          > droppedBeforeRelease,
        5_000,
        'the releaseSlot A1 cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 0,
        5_000,
        'the local slot to be free after A2 ends',
      )
      // Let the lost last-attempt send settle before a later dispatch, so this
      // cannot race the in-flight batch.
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(inbox.cancels.some(event => event.assignmentId === a1.id)).toBe(false)

      // Fill the local slot again so a later Ticket must overflow to N1, then
      // restore forwarding. With the orphan record kept, the later dispatch
      // resends A1's cancel and orders its body after it.
      const blocker2Id = createTicket(runtime, 'cancel_lost_last_attempt_blocker2')
      held.set(blocker2Id, gate())
      void runtime.harness.launch(loadTicket(runtime, blocker2Id))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held again',
      )
      proxy.dropping = false

      const laterId = createTicket(runtime, 'cancel_lost_last_attempt_later')
      await runtime.harness.launch(loadTicket(runtime, laterId))
      const laterAssignment = loadTicket(runtime, laterId).assignments.at(-1)!
      expect(laterAssignment.node).toBe(REMOTE_NODE_ID)

      // Wait for both arrivals; asserting after only one would race.
      await waitFor(
        () => stampIndex(inbox.stamps, 'cancel', a1.id) >= 0
          && stampIndex(inbox.stamps, 'assignment', laterAssignment.id) >= 0,
        10_000,
        'A1 cancel and the later Ticket body to reach the worker',
      )
      const cancelIndex = stampIndex(inbox.stamps, 'cancel', a1.id)
      const laterIndex = stampIndex(inbox.stamps, 'assignment', laterAssignment.id)
      expect(cancelIndex).toBeLessThanOrEqual(laterIndex)
      expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[laterIndex].at)

      // The gap is a local replacement that has already ended: T1 has no remote
      // sticky, A2 is ended, and T1 is still open (failed report, not a
      // successful Ticket end).
      const current = loadTicket(runtime, ticketId)
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
      expect(current.ended).toBeUndefined()
      expect(current.assignments.find(item => item.id === a1.id)?.state).toBe('ended')
      expect(current.assignments.find(item => item.id === a2.id)?.state).toBe('ended')
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('keeps a lost terminal sticky cancel when no local replacement exists', async () => {
    // One remote worker behind a cancel-dropping proxy, local mesh capacity 1.
    // A1 overflows to N1. A production successful report ends both A1 and T1,
    // so `releaseSlot` runs through the sticky-path terminal cancel with no
    // local replacement: it starts the fail-soft cancel and then releases the
    // sticky. That send is lost (502), so the Worker still holds A1 while T1
    // has no remote sticky and no local replacement. Unlike the a1d2d90
    // last-attempt path there is no retry here, and unlike crash recovery this
    // is the same process. If the terminal cancel is not recorded when it
    // starts, a later Ticket overflowing to N1 has nothing to resend and its
    // body reaches the Worker that still holds A1.
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDroppingProxy(inbox.url)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-sticky-terminal-lost-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so T1 has to overflow to N1.
      const blockerId = createTicket(runtime, 'cancel_sticky_terminal_lost_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const ticketId = createTicket(runtime, 'cancel_sticky_terminal_lost')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inbox.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Terminal sticky-path cancel: the production successful report ends A1
      // and the Ticket, so no local replacement is ever placed and no retry
      // runs. Lose the cancel; keep-vs-release frees T1's remote sticky.
      proxy.dropping = true
      expect(runtime.engine.report(ticketId, {
        kind: 'ready',
        text: 'remote done',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeDefined()
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 sticky slot to be released after the lost cancel',
      )
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
      // Let the failed sticky-path cancel fully settle so the later dispatch
      // cannot race its in-flight batch.
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(inbox.cancels.some(event => event.assignmentId === a1.id)).toBe(false)

      // Keep the blocker held, restore forwarding, and overflow a later Ticket
      // to N1. The terminal cancel must be resent from the kept orphan record,
      // and the later body ordered after it.
      proxy.dropping = false
      const laterId = createTicket(runtime, 'cancel_sticky_terminal_lost_later')
      await runtime.harness.launch(loadTicket(runtime, laterId))
      const laterAssignment = loadTicket(runtime, laterId).assignments.at(-1)!
      expect(laterAssignment.node).toBe(REMOTE_NODE_ID)

      // Wait for both arrivals; asserting after only one would race.
      await waitFor(
        () => stampIndex(inbox.stamps, 'cancel', a1.id) >= 0
          && stampIndex(inbox.stamps, 'assignment', laterAssignment.id) >= 0,
        10_000,
        'A1 cancel and the later Ticket body to reach the worker',
      )
      const cancelIndex = stampIndex(inbox.stamps, 'cancel', a1.id)
      const laterIndex = stampIndex(inbox.stamps, 'assignment', laterAssignment.id)
      expect(cancelIndex).toBeLessThanOrEqual(laterIndex)
      expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[laterIndex].at)

      // Still the terminal gap: T1 ended with no local replacement and no
      // remote sticky, so this cannot pass through the a1d2d90 no-sticky
      // last-attempt path or a crash leftover-restore path.
      const current = loadTicket(runtime, ticketId)
      expect(current.ended).toBeDefined()
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
      expect(current.assignments.map(item => item.id)).toEqual([a1.id])
      expect(current.assignments[0]?.state).toBe('ended')
      expect(runtime.placement.local.inFlight(HOST_PEER)).toBe(1)
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('keeps a lost keep-slot predecessor cancel resendable by a later same-node Ticket', async () => {
    // One remote worker behind a cancel-dropping proxy whose 502 is delayed
    // just long enough for `Runtime.retry` to place A2 while A1's failed-report
    // cancel is still in flight. Local mesh capacity is 1; N1 has capacity 2 so
    // a later Ticket can overflow there while the live replacement A2 still
    // holds a slot. The retry keeps T1's N1 sticky (`reason=live-replacement`),
    // but A1's cancel is lost. The keep-slot path must leave a dispatch-time
    // resend record anyway; otherwise the later body reaches a Worker that
    // still holds A1 and no cancel is ever queued.
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDroppingProxy(inbox.url)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-keep-slot-lost-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 2,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so T1 has to overflow to N1.
      const blockerId = createTicket(runtime, 'cancel_keep_slot_lost_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const ticketId = createTicket(runtime, 'cancel_keep_slot_lost')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inbox.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Delay the 502 so the retry below can place A2 while A1's predecessor
      // cancel is still in flight; the settle path then sees a live
      // replacement and keeps the sticky.
      proxy.dropping = true
      proxy.dropDelayMs = 250
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote worker result timeout',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()

      // Same-turn production relaunch: `retryTicket` is synchronous, and the
      // launch yields so the queued releaseSlot microtask starts A1's cancel
      // before A2 is placed.
      const retried = await runtime.retry(ticketId)
      expect(retried?.ended).toBeUndefined()

      await waitFor(
        () => {
          const current = loadTicket(runtime, ticketId)
          const latest = current.assignments.at(-1)
          return latest !== undefined
            && latest.id !== a1.id
            && latest.node === REMOTE_NODE_ID
            && latest.state !== 'ended'
        },
        10_000,
        'A2 to be placed on N1 as a live replacement',
      )
      const afterRetry = loadTicket(runtime, ticketId)
      const a2 = afterRetry.assignments.at(-1)!
      expect(a2.id).not.toBe(a1.id)
      expect(a2.node).toBe(REMOTE_NODE_ID)

      // The keep-slot path: A1's cancel is dropped, T1 keeps its N1 sticky,
      // T1 stays open and A2 runs.
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remoteHasTicket(ticketId),
        5_000,
        'T1 to keep its N1 sticky',
      )
      await waitFor(
        () => runtime.log.text().includes(
          `[mesh] remote cancel kept slot ticketId=${ticketId} assignmentId=${a1.id} replacementId=${a2.id} reason=live-replacement`,
        ),
        5_000,
        'the lost keep-slot cancel to keep the live replacement sticky',
      )
      // Let the failed send fully settle so the later dispatch cannot race its
      // in-flight batch.
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(inbox.cancels.some(event => event.assignmentId === a1.id)).toBe(false)
      const keepSlotState = loadTicket(runtime, ticketId)
      expect(keepSlotState.ended).toBeUndefined()
      expect(keepSlotState.assignments.at(-1)?.id).toBe(a2.id)
      expect(keepSlotState.assignments.find(item => item.id === a2.id)?.state).toBe('running')
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(true)

      // Keep the local blocker held and restore forwarding. The later Ticket
      // overflows onto N1's spare capacity while A2 still runs.
      proxy.dropping = false
      const laterId = createTicket(runtime, 'cancel_keep_slot_lost_later')
      await runtime.harness.launch(loadTicket(runtime, laterId))
      const laterAssignment = loadTicket(runtime, laterId).assignments.at(-1)!
      expect(laterAssignment.node).toBe(REMOTE_NODE_ID)

      // Wait for both arrivals; asserting after only one would race.
      await waitFor(
        () => stampIndex(inbox.stamps, 'cancel', a1.id) >= 0
          && stampIndex(inbox.stamps, 'assignment', laterAssignment.id) >= 0,
        10_000,
        'A1 cancel and the later Ticket body to reach N1',
      )
      const cancelIndex = stampIndex(inbox.stamps, 'cancel', a1.id)
      const laterIndex = stampIndex(inbox.stamps, 'assignment', laterAssignment.id)
      expect(cancelIndex).toBeLessThanOrEqual(laterIndex)
      expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[laterIndex].at)

      // Still the keep-slot gap: T1 is open with its N1 sticky and A2 is the
      // latest running Assignment; no local replacement exists. So this cannot
      // pass through the 5e2d9b6 no-replacement terminal path, the a1d2d90
      // no-sticky last-attempt path, or a crash leftover-restore path.
      const current = loadTicket(runtime, ticketId)
      expect(current.ended).toBeUndefined()
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(true)
      expect(current.assignments.map(item => item.id)).toEqual([a1.id, a2.id])
      expect(current.assignments.find(item => item.id === a1.id)?.state).toBe('ended')
      expect(current.assignments.find(item => item.id === a2.id)?.state).toBe('running')
      expect(current.assignments.at(-1)?.id).toBe(a2.id)
      // The local slot is still held only by the blocker: no local replacement
      // was placed for T1.
      expect(runtime.placement.local.inFlight(HOST_PEER)).toBe(1)
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('keeps a delivered last-attempt record for a later lost terminal cancel', async () => {
    // One remote worker behind a cancel-dropping proxy, local mesh capacity 1.
    // A1 overflows to N1 and loses its failed-report cancel, releasing the
    // sticky. A local-first retry places A2 on the host; its placement-time A1
    // cancel is lost too. A2 then ends through the production failed-report
    // path, so `releaseSlot` starts the no-sticky last-attempt A1 cancel; the
    // proxy delays and then *delivers* that send. While it is in flight, a
    // second local blocker forces another overflow and `Runtime.retry` places
    // A3 on N1 (sticky gained). A3 ends through a failed report: its terminal
    // sticky cancel batch includes the delayed A1 send plus A3's own cancel,
    // which is lost. The last-attempt batch settles first, sees the sticky A3
    // gained, and must not consume the record: A3 is still an uncovered ended
    // remote. The terminal `!delivered` arm must also be able to re-add the
    // record rather than assume it survived. Otherwise a later Ticket
    // overflowing to N1 has nothing to resend and its body reaches a Worker
    // that still holds A3.
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDroppingProxy(inbox.url)

    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ds-mesh-cancel-last-attempt-terminal-lost-'),
    )
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    try {
      // 1. Hold the only local slot so T1 overflows to N1 as A1.
      const blockerId = createTicket(runtime, 'cancel_last_attempt_terminal_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const ticketId = createTicket(runtime, 'cancel_last_attempt_terminal')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inbox.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Lose A1's failed-report cancel. After the failed send settles
      // keep-vs-release frees T1's remote sticky; the worker holds A1.
      proxy.dropping = true
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote worker failed',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 sticky slot to be released after the lost cancel',
      )
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)

      // 2. Free the local slot and retry T1 local-first. Hold A2's worker turn;
      // its placement-time A1 cancel is lost as well.
      expect(runtime.engine.report(blockerId, {
        kind: 'ready',
        text: 'blocker done',
        deliver: false,
      }).surfaced).toBe(false)
      held.get(blockerId)?.release()
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 0,
        5_000,
        'the local slot to be released after the holder ends',
      )

      const droppedBeforeRetry = proxy.dropped
        .filter(item => item.assignmentId === a1.id).length
      held.set(ticketId, gate())
      void runtime.retry(ticketId, 'local-replacement-retry').catch(() => undefined)
      await waitFor(
        () => loadTicket(runtime, ticketId).assignments.at(-1)?.state === 'running',
        5_000,
        'A2 to be running',
      )
      const a2 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a2.id).not.toBe(a1.id)
      expect(runtime.placement.isRemote(a2.node)).toBe(false)
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
      await waitFor(
        () => proxy.dropped.filter(item => item.assignmentId === a1.id).length
          > droppedBeforeRetry,
        5_000,
        'the local-placement A1 cancel to be dropped',
      )

      // 3. End A2 through the production failed-report path. Its last-attempt
      // A1 cancel is delayed and then delivered, so the settle path will see a
      // sticky gained later while its send was in flight.
      proxy.forwardDelays.set(a1.id, 1_200)
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'local replacement failed',
        deliver: false,
      }).surfaced).toBe(false)
      held.get(ticketId)?.release()
      held.delete(ticketId)
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 0,
        5_000,
        'the local slot to be free after A2 ends',
      )
      await waitFor(
        () => proxy.delayedForwards.some(item => item.assignmentId === a1.id),
        5_000,
        'the last-attempt A1 cancel to be delayed in flight',
      )

      // 4. While that send is in flight, refill the local slot and retry T1
      // onto N1 as A3. The sticky is gained before the last-attempt settles.
      const blocker2Id = createTicket(runtime, 'cancel_last_attempt_terminal_blocker2')
      held.set(blocker2Id, gate())
      void runtime.harness.launch(loadTicket(runtime, blocker2Id))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held again',
      )

      held.set(ticketId, gate())
      const retried = await runtime.retry(ticketId, 'remote-a3-retry')
      expect(retried?.ended).toBeUndefined()
      await waitFor(
        () => {
          const latest = loadTicket(runtime, ticketId).assignments.at(-1)
          return latest !== undefined
            && latest.id !== a2.id
            && latest.node === REMOTE_NODE_ID
            && latest.state !== 'ended'
        },
        10_000,
        'A3 to be placed on N1',
      )
      const a3 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a3.id).not.toBe(a1.id)
      expect(a3.id).not.toBe(a2.id)
      await waitFor(
        () => stampIndex(inbox.stamps, 'assignment', a3.id) >= 0,
        5_000,
        'A3 body to reach N1',
      )
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(true)

      // 5. End A3. Its terminal sticky batch waits on a delayed A1 cancel and
      // loses A3's own cancel. Wait for the sticky release, which happens only
      // after that whole batch settles.
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote A3 failed',
        deliver: false,
      }).surfaced).toBe(false)
      held.get(ticketId)?.release()
      held.delete(ticketId)
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a3.id),
        5_000,
        'A3 terminal cancel to be dropped',
      )
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 sticky to be released after the terminal batch settles',
      )
      // Let the last-attempt settle (it started before the terminal batch)
      // finish before a later dispatch can race its in-flight batch.
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
      expect(inbox.cancels.some(event => event.assignmentId === a3.id)).toBe(false)

      // 6. Restore forwarding and overflow a later Ticket to N1. The kept
      // orphan record must resend A3's cancel and order the later body after
      // it.
      proxy.dropping = false
      proxy.forwardDelays.clear()
      const laterId = createTicket(runtime, 'cancel_last_attempt_terminal_later')
      await runtime.harness.launch(loadTicket(runtime, laterId))
      const laterAssignment = loadTicket(runtime, laterId).assignments.at(-1)!
      expect(laterAssignment.node).toBe(REMOTE_NODE_ID)

      // Wait for both arrivals; asserting after only one would race.
      await waitFor(
        () => stampIndex(inbox.stamps, 'cancel', a3.id) >= 0
          && stampIndex(inbox.stamps, 'assignment', laterAssignment.id) >= 0,
        10_000,
        'A3 cancel and the later Ticket body to reach N1',
      )
      const cancelIndex = stampIndex(inbox.stamps, 'cancel', a3.id)
      const laterIndex = stampIndex(inbox.stamps, 'assignment', laterAssignment.id)
      expect(cancelIndex).toBeLessThanOrEqual(laterIndex)
      expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[laterIndex].at)

      // The gap this covers: T1 is open with A3 ended, no local replacement
      // and no remote sticky. The failed reports never claim a successful
      // cross-machine result.
      const current = loadTicket(runtime, ticketId)
      expect(current.ended).toBeUndefined()
      expect(current.assignments.find(item => item.id === a3.id)?.state).toBe('ended')
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
      expect(runtime.placement.local.inFlight(HOST_PEER)).toBe(1)
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('resends a settled lost terminal cancel before the same Ticket retries to the same worker', async () => {
    // Dispatch-time resend skipping the *dispatching* Ticket is correct for a
    // different-Ticket drive-by, but `Runtime.retry` reuses the same path for
    // the Ticket being relaunched. Here A1's terminal cancel was lost and has
    // already settled (sticky released, no in-flight batch, no barrier), so
    // this is not the 2a2de80 in-flight skip. The same Ticket's local-first
    // retry overflows A2 back to N1 while the local slot stays held; A1's
    // cancel must be resent and delivered before A2's body reaches the Worker.
    const inbox = await startWorkerInbox()
    const proxy = await startCancelDroppingProxy(inbox.url)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-same-ticket-settled-resend-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so T1 has to overflow to N1.
      const blockerId = createTicket(runtime, 'cancel_same_ticket_settled_resend_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const ticketId = createTicket(runtime, 'cancel_same_ticket_settled_resend_t1')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inbox.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Lose A1's failed-report terminal cancel. The settle path releases T1's
      // remote sticky but the Worker still holds the ended Assignment.
      proxy.dropping = true
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'remote worker failed',
        deliver: false,
      }).surfaced).toBe(false)
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 terminal cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
        5_000,
        'the N1 sticky slot to be released after the lost cancel',
      )
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(false)
      // Let the lost send fully settle: this regression is about a settled
      // cancel, not a batch still in flight when retry was requested.
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(inbox.cancels.some(event => event.assignmentId === a1.id)).toBe(false)

      // Keep the local slot held, restore forwarding, and retry the *same*
      // Ticket. Local-first placement overflows A2 back to N1.
      proxy.dropping = false
      const droppedBeforeRetry = proxy.dropped
        .filter(item => item.assignmentId === a1.id).length
      await runtime.retry(ticketId, 'same-ticket-overflow-retry')
      await waitFor(
        () => loadTicket(runtime, ticketId).assignments.at(-1)?.state === 'running',
        5_000,
        'A2 to be running',
      )
      const retried = loadTicket(runtime, ticketId)
      const a2 = retried.assignments.at(-1)!
      expect(a2.id).not.toBe(a1.id)
      expect(a2.node).toBe(REMOTE_NODE_ID)
      expect(retried.ended).toBeUndefined()
      expect(retried.assignments.find(item => item.id === a1.id)?.state).toBe('ended')

      // Wait for both arrivals; asserting after only one would race. The
      // same-Ticket resend started at dispatch time must order the cancel
      // before the replacement body.
      await waitFor(
        () => stampIndex(inbox.stamps, 'cancel', a1.id) >= 0
          && stampIndex(inbox.stamps, 'assignment', a2.id) >= 0,
        10_000,
        'A1 cancel and the same Ticket A2 body to reach N1',
      )
      const cancelIndex = stampIndex(inbox.stamps, 'cancel', a1.id)
      const bodyIndex = stampIndex(inbox.stamps, 'assignment', a2.id)
      expect(cancelIndex).toBeLessThanOrEqual(bodyIndex)
      expect(inbox.stamps[cancelIndex].at).toBeLessThanOrEqual(inbox.stamps[bodyIndex].at)
      // The resend was a fresh delivered send, not another dropped attempt.
      expect(proxy.dropped.filter(item => item.assignmentId === a1.id).length)
        .toBe(droppedBeforeRetry)

      // Same-process retry: T1 stays open, A1 ended, A2 on N1. The failed
      // reports never claim a successful cross-machine result.
      expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
      expect(runtime.placement.remoteHasTicket(ticketId)).toBe(true)
      expect(runtime.placement.local.inFlight(HOST_PEER)).toBe(1)
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('resends a cancel lost while a later Ticket was already waiting to dispatch', async () => {
    // Same process, three Tickets on one remote worker. Local mesh capacity is
    // 1 and N1 has capacity 3, so T0 and T1 overflow to N1 and run. T0's
    // failed-report terminal cancel is *delayed* (not lost), so its sticky is
    // still held and T2, placed on N1, waits in
    // `settleRemoteCancelSendsToNode` for that in-flight send. While T2 waits,
    // T1's terminal cancel is lost (502) and settles: T1's sticky is released
    // but the Worker still holds A1. The start-of-dispatch resend ran before T1
    // ended, so only a post-wait resend can order A1's cancel before T2's body.
    const inbox = await startWorkerInbox()
    const proxy = await startSelectiveCancelProxy(inbox.url, 1_500)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-mid-wait-loss-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 3,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so T0 and T1 have to overflow to N1.
      const blockerId = createTicket(runtime, 'cancel_mid_wait_loss_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const launchOverflow = async (slug: string) => {
        const ticketId = createTicket(runtime, slug)
        await runtime.harness.launch(loadTicket(runtime, ticketId))
        await waitFor(
          () => inbox.assignments.some(event => event.ticketId === ticketId),
          5_000,
          `${slug} to reach N1`,
        )
        const assignment = loadTicket(runtime, ticketId).assignments.at(-1)!
        expect(assignment.node).toBe(REMOTE_NODE_ID)
        expect(assignment.state).toBe('running')
        return { ticketId, assignment }
      }

      const t0 = await launchOverflow('cancel_mid_wait_loss_t0')
      const t1 = await launchOverflow('cancel_mid_wait_loss_t1')

      // Delay T0's terminal cancel so T2's dispatch has an in-flight
      // other-Ticket batch to wait on, and its sticky stays held.
      proxy.delayIds.add(t0.assignment.id)
      expect(runtime.engine.report(t0.ticketId, {
        kind: 'failed',
        text: 't0 remote failed',
        deliver: false,
      }).surfaced).toBe(false)
      await waitFor(
        () => proxy.delayed.some(item => item.assignmentId === t0.assignment.id),
        5_000,
        'T0 cancel to be delayed at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remoteHasTicket(t0.ticketId),
        2_000,
        'T0 sticky to remain held during the delayed cancel',
      )

      // Place T2 on N1's spare capacity. Launch does not resolve until the
      // body is dispatched, so keep its promise handled and observe placement.
      const t2Id = createTicket(runtime, 'cancel_mid_wait_loss_t2')
      const t2Launch = runtime.harness.launch(loadTicket(runtime, t2Id))
      void t2Launch.catch(() => undefined)
      await waitFor(
        () => loadTicket(runtime, t2Id).assignments.at(-1)?.node === REMOTE_NODE_ID,
        5_000,
        'T2 to be placed on N1',
      )
      // The body must still be held behind T0's delayed cancel.
      expect(proxy.delayed.some(item => item.assignmentId === t0.assignment.id)).toBe(true)
      expect(inbox.assignments.some(event => event.ticketId === t2Id)).toBe(false)

      // While T2 waits, lose T1's terminal cancel and let it settle. The lost
      // send releases T1's sticky but leaves the Worker holding A1.
      proxy.dropIds.add(t1.assignment.id)
      expect(runtime.engine.report(t1.ticketId, {
        kind: 'failed',
        text: 't1 remote failed',
        deliver: false,
      }).surfaced).toBe(false)
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === t1.assignment.id),
        5_000,
        'T1 terminal cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => !runtime.placement.remoteHasTicket(t1.ticketId),
        5_000,
        'T1 sticky to be released after the lost cancel settled',
      )
      // Stop dropping T1 so the post-wait resend can actually be delivered.
      proxy.dropIds.delete(t1.assignment.id)

      // T0's delayed cancel is delivered, T2's wait ends, and the post-wait
      // resend must resend A1's cancel before T2's body.
      await waitFor(
        () => inbox.cancels.some(event => event.assignmentId === t1.assignment.id)
          && inbox.assignments.some(event => event.ticketId === t2Id),
        10_000,
        'A1 cancel and the T2 body to reach N1',
      )
      const a1CancelIndex = stampIndex(inbox.stamps, 'cancel', t1.assignment.id)
      const a2 = loadTicket(runtime, t2Id).assignments.at(-1)!
      const bodyIndex = stampIndex(inbox.stamps, 'assignment', a2.id)
      expect(a1CancelIndex).toBeGreaterThanOrEqual(0)
      expect(bodyIndex).toBeGreaterThanOrEqual(0)
      expect(a1CancelIndex).toBeLessThanOrEqual(bodyIndex)
      expect(inbox.stamps[a1CancelIndex].at).toBeLessThanOrEqual(inbox.stamps[bodyIndex].at)

      // Same-process state: T1 open with A1 ended, T2/A2 running on N1. The
      // failed reports never claim a successful cross-machine result.
      const t1State = loadTicket(runtime, t1.ticketId)
      expect(t1State.ended).toBeUndefined()
      expect(t1State.assignments.find(item => item.id === t1.assignment.id)?.state).toBe('ended')
      const t2State = loadTicket(runtime, t2Id)
      expect(t2State.ended).toBeUndefined()
      expect(a2.node).toBe(REMOTE_NODE_ID)
      expect(a2.state).toBe('running')
      expect(t2State.assignments.at(-1)?.id).toBe(a2.id)
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('resends a cancel lost while a later Ticket waits on a post-wait resend', async () => {
    // Same process, four Tickets on one remote worker. Local mesh capacity is
    // 1 so T0, T1, and T2 overflow to N1 (capacity 4) and run. T0's terminal
    // cancel is *delayed*, so T3, placed on N1, waits in the first
    // `settleRemoteCancelSendsToNode` with its body still held. While T3 waits,
    // T1's terminal cancel is lost (502) and settles; T1 is then switched from
    // drop to delay so T3's post-wait resend of A1 is held rather than
    // delivered. While T3 waits on that post-wait send, T2's terminal cancel is
    // also lost (502) and settles. A single post-wait resend (b791f50) cannot
    // see T2, so without a drain T3's body reaches the Worker that still holds
    // the uncancelled A2.
    const inbox = await startWorkerInbox()
    const proxy = await startSelectiveCancelProxy(inbox.url, 1_600)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-post-wait-loss-'))
    homes.push(home)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(home, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 4,
    })
    runtime.start({ assessPending: false })

    try {
      // Hold the only local slot so every Ticket below overflows to N1.
      const blockerId = createTicket(runtime, 'cancel_post_wait_loss_blocker')
      held.set(blockerId, gate())
      void runtime.harness.launch(loadTicket(runtime, blockerId))
      await waitFor(
        () => runtime.placement.local.inFlight(HOST_PEER) === 1,
        5_000,
        'the local slot to be held',
      )

      const launchOverflow = async (slug: string) => {
        const ticketId = createTicket(runtime, slug)
        await runtime.harness.launch(loadTicket(runtime, ticketId))
        await waitFor(
          () => inbox.assignments.some(event => event.ticketId === ticketId),
          5_000,
          `${slug} to reach N1`,
        )
        const assignment = loadTicket(runtime, ticketId).assignments.at(-1)!
        expect(assignment.node).toBe(REMOTE_NODE_ID)
        expect(assignment.state).toBe('running')
        return { ticketId, assignment }
      }

      const t0 = await launchOverflow('cancel_post_wait_loss_t0')
      const t1 = await launchOverflow('cancel_post_wait_loss_t1')
      const t2 = await launchOverflow('cancel_post_wait_loss_t2')

      // Delay T0's terminal cancel so T3 has an other-Ticket batch to wait on
      // and T0's sticky stays held.
      proxy.delayIds.add(t0.assignment.id)
      expect(runtime.engine.report(t0.ticketId, {
        kind: 'failed',
        text: 't0 remote failed',
        deliver: false,
      }).surfaced).toBe(false)
      await waitFor(
        () => proxy.delayed.some(item => item.assignmentId === t0.assignment.id),
        5_000,
        'T0 cancel to be delayed at the N1 proxy',
      )
      await waitFor(
        () => runtime.placement.remoteHasTicket(t0.ticketId),
        2_000,
        'T0 sticky to remain held during the delayed cancel',
      )

      // T3 is placed on N1 but its body must wait behind T0's delayed cancel.
      const t3Id = createTicket(runtime, 'cancel_post_wait_loss_t3')
      const t3Launch = runtime.harness.launch(loadTicket(runtime, t3Id))
      void t3Launch.catch(() => undefined)
      await waitFor(
        () => loadTicket(runtime, t3Id).assignments.at(-1)?.node === REMOTE_NODE_ID,
        5_000,
        'T3 to be placed on N1',
      )
      expect(inbox.assignments.some(event => event.ticketId === t3Id)).toBe(false)

      // While T3 is in the first wait, lose T1's terminal cancel and let it
      // settle. Then switch T1 from drop to delay so T3's post-wait resend of
      // A1 is held in flight.
      proxy.dropIds.add(t1.assignment.id)
      expect(runtime.engine.report(t1.ticketId, {
        kind: 'failed',
        text: 't1 remote failed',
        deliver: false,
      }).surfaced).toBe(false)
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === t1.assignment.id),
        5_000,
        'T1 terminal cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => !runtime.placement.remoteHasTicket(t1.ticketId),
        5_000,
        'T1 sticky to be released after the lost cancel settled',
      )
      proxy.dropIds.delete(t1.assignment.id)
      proxy.delayIds.add(t1.assignment.id)

      // T0's delayed cancel is delivered, T3's post-wait resend of A1 starts
      // and is held, and the body is still not delivered.
      await waitFor(
        () => proxy.delayed.some(item => item.assignmentId === t1.assignment.id)
          && !inbox.assignments.some(event => event.ticketId === t3Id),
        8_000,
        'A1 post-wait resend to be delayed with the T3 body still held',
      )

      // While T3 waits on that post-wait send, lose T2's terminal cancel and
      // let it settle. This is the new orphan that appeared during the
      // post-wait wait; restore forwarding afterward so the drain's resend can
      // be delivered.
      proxy.dropIds.add(t2.assignment.id)
      expect(runtime.engine.report(t2.ticketId, {
        kind: 'failed',
        text: 't2 remote failed',
        deliver: false,
      }).surfaced).toBe(false)
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === t2.assignment.id),
        5_000,
        'T2 terminal cancel to be dropped at the N1 proxy',
      )
      await waitFor(
        () => !runtime.placement.remoteHasTicket(t2.ticketId),
        5_000,
        'T2 sticky to be released after the lost cancel settled',
      )
      proxy.dropIds.delete(t2.assignment.id)

      // A2's cancel must be resent and reach N1 before T3's body.
      await waitFor(
        () => inbox.cancels.some(event => event.assignmentId === t2.assignment.id)
          && inbox.assignments.some(event => event.ticketId === t3Id),
        10_000,
        'A2 cancel and the T3 body to reach N1',
      )
      const a2CancelIndex = stampIndex(inbox.stamps, 'cancel', t2.assignment.id)
      const a3 = loadTicket(runtime, t3Id).assignments.at(-1)!
      const bodyIndex = stampIndex(inbox.stamps, 'assignment', a3.id)
      expect(a2CancelIndex).toBeGreaterThanOrEqual(0)
      expect(bodyIndex).toBeGreaterThanOrEqual(0)
      expect(a2CancelIndex).toBeLessThanOrEqual(bodyIndex)
      expect(inbox.stamps[a2CancelIndex].at).toBeLessThanOrEqual(inbox.stamps[bodyIndex].at)

      // Same-process state: T2 open with A2 ended, T3/A3 running on N1. The
      // failed reports never claim a successful cross-machine result.
      const t2State = loadTicket(runtime, t2.ticketId)
      expect(t2State.ended).toBeUndefined()
      expect(t2State.assignments.find(item => item.id === t2.assignment.id)?.state).toBe('ended')
      const t3State = loadTicket(runtime, t3Id)
      expect(t3State.ended).toBeUndefined()
      expect(a3.node).toBe(REMOTE_NODE_ID)
      expect(a3.state).toBe('running')
      expect(t3State.assignments.at(-1)?.id).toBe(a3.id)
    } finally {
      for (const hold of held.values()) hold.release()
      await shutdown(runtime)
    }
  }, 60_000)

  it('resends a settled lost own-Ticket cancel while an older same-Ticket cancel is in flight', async () => {
    // Same process, one Ticket on one remote worker. A required capability
    // forces every placement onto N1 (capacity 1). A1 runs; its failed-report
    // terminal cancel is *delayed and still in flight*. `Runtime.retry` places
    // A2 without waiting for it (2a2de80), then A2's terminal cancel is lost
    // (502) and settles while A1's cancel is still in flight. Ending A2 starts
    // another delayed A1 cancel (superseded ended remote). The next retry must
    // still resend the settled lost A2 cancel before A3's body: a blanket
    // same-Ticket in-flight skip would hide it and leave the Worker holding A2.
    const inbox = await startWorkerInbox()
    const proxy = await startSelectiveCancelProxy(inbox.url, 9_000)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-own-cancel-inflight-'))
    homes.push(home)
    const runtime = runtimeFor(
      home,
      holdingModel(new Map()),
      60_000,
      'cancel-own-inflight-required',
    )
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: proxy.url,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: ['cancel-own-inflight-required'],
    })
    runtime.start({ assessPending: false })

    try {
      const ticketId = createTicket(runtime, 'cancel_own_inflight_resend')
      await runtime.harness.launch(loadTicket(runtime, ticketId))
      await waitFor(
        () => inbox.assignments.some(event => event.ticketId === ticketId),
        5_000,
        'A1 to reach N1',
      )
      const a1 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a1.node).toBe(REMOTE_NODE_ID)
      expect(a1.state).toBe('running')

      // Delay A1's terminal cancel so it is still in flight across the whole
      // A2 -> A3 window; the Worker must never see it here.
      proxy.delayIds.add(a1.id)
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'a1 remote failed',
        deliver: false,
      }).surfaced).toBe(false)
      await waitFor(
        () => proxy.delayed.some(item => item.assignmentId === a1.id),
        5_000,
        'A1 terminal cancel to be delayed at the N1 proxy',
      )
      expect(stampIndex(inbox.stamps, 'cancel', a1.id)).toBe(-1)

      // 2a2de80: the retry must not wait for A1's delayed cancel.
      expect(await runtime.retry(ticketId, 'a2-retry')).toBeDefined()
      await waitFor(
        () => loadTicket(runtime, ticketId).assignments.length >= 2
          && inbox.assignments.some(
            event => assignmentIdOf(event) === loadTicket(runtime, ticketId).assignments.at(-1)!.id,
          ),
        5_000,
        'A2 body to reach N1',
      )
      const a2 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a2.id).not.toBe(a1.id)
      expect(a2.node).toBe(REMOTE_NODE_ID)
      expect(a2.state).toBe('running')
      // A2's body went out ahead of A1's delayed cancel (the tradeoff), and the
      // in-flight window stayed open.
      expect(stampIndex(inbox.stamps, 'cancel', a1.id)).toBe(-1)

      // Lose A2's terminal cancel and let it settle. Ending A2 also starts a
      // superseded A1 cancel, which stays delayed and in flight.
      proxy.dropIds.add(a2.id)
      expect(runtime.engine.report(ticketId, {
        kind: 'failed',
        text: 'a2 remote failed',
        deliver: false,
      }).surfaced).toBe(false)
      await waitFor(
        () => proxy.dropped.some(item => item.assignmentId === a2.id),
        5_000,
        'A2 terminal cancel to be dropped at the N1 proxy',
      )
      // Let the lost send settle (A1's delayed cancel keeps the sticky held, so
      // the slot alone is not an observable for this send).
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(inbox.cancels.some(event => event.assignmentId === a2.id)).toBe(false)
      expect(stampIndex(inbox.stamps, 'cancel', a1.id)).toBe(-1)
      // Stop dropping A2 so the dispatch-time resend can be delivered.
      proxy.dropIds.delete(a2.id)

      // A1's cancel is still in flight, so a blanket same-Ticket skip would
      // start nothing here and A3's body would reach the Worker that still
      // holds A2. The per-target skip must still resend A2's settled lost
      // cancel before the body.
      expect(await runtime.retry(ticketId, 'a3-retry')).toBeDefined()
      await waitFor(
        () => loadTicket(runtime, ticketId).assignments.length >= 3
          && inbox.assignments.some(
            event => assignmentIdOf(event) === loadTicket(runtime, ticketId).assignments.at(-1)!.id,
          ),
        8_000,
        'A3 body to reach N1',
      )
      const a3 = loadTicket(runtime, ticketId).assignments.at(-1)!
      expect(a3.id).not.toBe(a2.id)
      expect(a3.node).toBe(REMOTE_NODE_ID)

      const a2CancelIndex = stampIndex(inbox.stamps, 'cancel', a2.id)
      const bodyIndex = stampIndex(inbox.stamps, 'assignment', a3.id)
      expect(a2CancelIndex).toBeGreaterThanOrEqual(0)
      expect(bodyIndex).toBeGreaterThanOrEqual(0)
      expect(a2CancelIndex).toBeLessThanOrEqual(bodyIndex)
      expect(inbox.stamps[a2CancelIndex].at).toBeLessThanOrEqual(inbox.stamps[bodyIndex].at)
      // The delayed A1 cancel is still in flight: this was not a settled-A1
      // case, so the resend above really was driven by per-target tracking.
      expect(stampIndex(inbox.stamps, 'cancel', a1.id)).toBe(-1)

      // Same-process state: T1 open, A1/A2 ended, A3 running on N1. The failed
      // reports never claim a successful cross-machine result.
      const state = loadTicket(runtime, ticketId)
      expect(state.ended).toBeUndefined()
      expect(state.assignments.find(item => item.id === a2.id)?.state).toBe('ended')
      expect(state.assignments.at(-1)?.id).toBe(a3.id)
      expect(a3.state).toBe('running')
    } finally {
      await shutdown(runtime)
    }
  }, 60_000)
})
