import type { A2ADelivery, A2AEnvelope } from '../channels/a2a.ts'
import { A2ARouter } from '../channels/a2a.ts'
import type { A2ATransport } from '../channels/a2a-transport.ts'
import {
  A2AHttpTransport,
  createA2AHttpHandler,
  type A2AHttpHandler,
  type A2AHttpTransportOptions,
  type A2ASecretResolver,
} from '../channels/a2a-http.ts'
import type { A2AReplayCache, A2ASecret } from '../channels/a2a-auth.ts'
import {
  A2A_AUTH_MAX_SKEW_MS,
  A2A_MIN_SECRET_BYTES,
} from '../channels/a2a-auth.ts'

/**
 * Client/registry half of the cross-host mesh (T47 transport half).
 *
 * This module registers remote Worker nodes over the authenticated A2A HTTP
 * primitive, tracks heartbeat and capacity, and dispatches assignment
 * envelopes fail-closed. It starts no listener: `createRemoteMeshHandler`
 * only returns a request handler and the process owner decides whether and
 * where to mount it. No Trigger is constructed here, and no remote Worker is
 * executed by this module — an assignment is delivered to the peer's inbox and
 * the peer's owner decides what to do with it.
 *
 * Secrets are held only for outbound signing. `list()` and every dispatch
 * result omit them, and no error path returns or throws peer-supplied text.
 */

/** A heartbeat older than this (default) makes a node ineligible. */
export const DEFAULT_REMOTE_STALE_MS = 60_000

/** Default cap on remote nodes a registry (and the handler's default registry) accepts. */
export const DEFAULT_REMOTE_MAX_NODES = 256

/** Default cap on distinct inbound addresses a mesh inbox accepts. */
export const DEFAULT_REMOTE_MAX_ADDRESSES = 64

/** Body kinds accepted by the remote mesh inbox. Everything else fails closed. */
export const REMOTE_MESH_BODY_KINDS = [
  'register',
  'heartbeat',
  'assignment',
  'assignment_cancel',
  'assignment_result',
] as const
export type RemoteMeshBodyKind = (typeof REMOTE_MESH_BODY_KINDS)[number]

export interface RemoteNodeRegistration {
  /** Stable node id, unique within this registry. */
  id: string
  /** Endpoint URL. Both the A2A transport guard and this module reject non-https,
   * non-loopback endpoints, and this module also rejects embedded credentials. */
  url: string
  /** The remote peer's authenticated identity used as the envelope `to`. */
  peerId: string
  /** Shared secret used to sign outbound requests. Never exposed by `list()`. */
  secret: A2ASecret
  /** Maximum concurrent assignments. Defaults to 1. */
  capacity?: number
  /** Advertised worker capabilities (for example `linux`, `bwrap`). Empty means generic. */
  capabilities?: readonly string[]
}

/** Public, secret-free view of a registered remote node. */
export interface RemoteMeshNode {
  id: string
  url: string
  peerId: string
  capacity: number
  capabilities: string[]
  online: boolean
  lastHeartbeatAt: number
  inFlight: number
  stale: boolean
}

/** Component-wise copy of the raw A2A delivery without peer-supplied error text. */
function safeDelivery(delivery: A2ADelivery): A2ADelivery {
  if (delivery.status === 'failed') {
    return {
      envelope: delivery.envelope,
      status: 'failed',
      delivered: delivery.delivered,
      persisted: delivery.persisted,
      // The peer's error text is never propagated. The HTTP transport already
      // maps failures to static messages, but an injected transport may not.
      error: 'remote delivery failed',
    }
  }
  return {
    envelope: delivery.envelope,
    status: delivery.status,
    delivered: delivery.delivered,
    persisted: delivery.persisted,
  }
}

function failedDelivery(envelope: A2AEnvelope): A2ADelivery {
  return {
    envelope,
    status: 'failed',
    delivered: 0,
    persisted: false,
    error: 'remote delivery failed',
  }
}

function isDelivery(value: unknown): value is A2ADelivery {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<A2ADelivery>
  if (candidate.status !== 'delivered'
    && candidate.status !== 'unroutable'
    && candidate.status !== 'failed') {
    return false
  }
  if (typeof candidate.delivered !== 'number'
    || !Number.isInteger(candidate.delivered)
    || candidate.delivered < 0) {
    return false
  }
  if (typeof candidate.persisted !== 'boolean') return false
  const envelope = candidate.envelope
  if (typeof envelope !== 'object' || envelope === null) return false
  if (typeof envelope.from !== 'string' || envelope.from.length === 0) return false
  if (typeof envelope.to !== 'string' || envelope.to.length === 0) return false
  return Object.prototype.hasOwnProperty.call(envelope, 'body')
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function assertSecret(secret: A2ASecret): void {
  const length = typeof secret === 'string'
    ? Buffer.byteLength(secret, 'utf8')
    : secret instanceof Uint8Array
      ? secret.byteLength
      : 0
  if (length < A2A_MIN_SECRET_BYTES) {
    // Static message: never echo the supplied secret.
    throw new Error(`Remote mesh node secret must be at least ${A2A_MIN_SECRET_BYTES} bytes`)
  }
}

/**
 * Reject endpoints that embed userinfo. The A2A transport guard validates the
 * scheme/host but not credentials, and this registry would otherwise persist
 * and list them (or echo them from the URL parser).
 */
function assertNoUrlCredentials(url: string): void {
  const parsed = new URL(url)
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error('Remote mesh node URL must not embed credentials')
  }
}

/**
 * Loopback and unspecified local addresses. Used only for the inbound
 * registration policy; the local registry still accepts an operator-supplied
 * loopback endpoint for tests and deliberate local deployments.
 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost'
    || host === '0.0.0.0'
    || host === '::'
    || host === '[::]'
    || host === '::1'
    || host === '[::1]') {
    return true
  }
  return /^127(?:\.\d{1,3}){3}$/u.test(host)
}

function capacityOf(value: number | undefined): number {
  const capacity = value ?? 1
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error('Remote mesh node requires a positive integer capacity')
  }
  return capacity
}

function finiteNow(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function boundedInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1 ? value : fallback
}

/** Injectable transport constructor used by tests. */
export type RemoteTransportFactory = (options: A2AHttpTransportOptions) => A2ATransport

export interface RemoteMeshRegistryOptions {
  /** This process's authenticated A2A identity; signs every outbound envelope. */
  localPeerId?: string
  /** Heartbeats older than this are ineligible. Defaults to 60 s. */
  staleAfterMs?: number
  /** Alias for `staleAfterMs`. */
  staleWindowMs?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /** Lazy transport factory. Defaults to `new A2AHttpTransport(...)`. */
  transportFactory?: RemoteTransportFactory
  /** Alias for `transportFactory`. */
  createTransport?: RemoteTransportFactory
  /** Maximum registered nodes. Defaults to 256. */
  maxNodes?: number
  /**
   * Notified with the node id when a node becomes eligible: a successful
   * register adds a new eligible node, and a heartbeat transitions an
   * ineligible (offline or stale) node back to eligible. Late wiring uses
   * `setOnBecameEligible` instead. The registry never starts dispatch itself.
   */
  onBecameEligible?: (nodeId: string) => void
}

interface RemoteNodeRecord {
  id: string
  url: string
  peerId: string
  secret: A2ASecret
  capacity: number
  capabilities: string[]
  online: boolean
  lastHeartbeatAt: number
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const caps: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) caps.push(item.trim())
  }
  return [...new Set(caps)]
}

function capabilitiesMatch(nodeCaps: readonly string[], required: readonly string[]): boolean {
  if (required.length === 0) return true
  return required.every(cap => nodeCaps.includes(cap))
}

function defaultTransportFactory(options: A2AHttpTransportOptions): A2ATransport {
  return new A2AHttpTransport(options)
}

/**
 * Registry and dispatcher for remote Worker nodes.
 *
 * Placement rules match the local `WorkerMeshRegistry`: least-loaded online
 * node with free capacity, sticky for an already-picked ticket, and no
 * assignment when nothing is eligible. The only network operation is
 * `dispatch`, which requires an existing `pick`/assignment and never picks on
 * the caller's behalf.
 */
export class RemoteMeshRegistry {
  readonly localPeerId: string
  readonly staleAfterMs: number
  readonly maxNodes: number
  private readonly clock: () => number
  private readonly createTransport: RemoteTransportFactory
  private readonly nodes = new Map<string, RemoteNodeRecord>()
  private readonly assignments = new Map<string, string>()
  private readonly transports = new Map<string, A2ATransport>()
  private becameEligibleListener?: (nodeId: string) => void

  constructor(options: RemoteMeshRegistryOptions | string = {}) {
    const resolved: RemoteMeshRegistryOptions = typeof options === 'string'
      ? { localPeerId: options }
      : options
    this.localPeerId = nonEmptyString(resolved.localPeerId) ? resolved.localPeerId : 'local'
    const stale = resolved.staleAfterMs ?? resolved.staleWindowMs ?? DEFAULT_REMOTE_STALE_MS
    this.staleAfterMs = Number.isFinite(stale) && stale >= 0
      ? Math.floor(stale)
      : DEFAULT_REMOTE_STALE_MS
    const maxNodes = resolved.maxNodes
    this.maxNodes = maxNodes !== undefined && Number.isSafeInteger(maxNodes) && maxNodes >= 1
      ? maxNodes
      : DEFAULT_REMOTE_MAX_NODES
    this.clock = resolved.now ?? (() => Date.now())
    this.createTransport = resolved.transportFactory
      ?? resolved.createTransport
      ?? defaultTransportFactory
    this.becameEligibleListener = resolved.onBecameEligible
  }

  /**
   * Replace the eligible-node listener. The Runtime wires this after the
   * Harness exists so a heartbeat that brings a node back, or a late-bound
   * register that adds an eligible node, can wake a parked mesh queue. Passing
   * `undefined` removes the listener.
   */
  setOnBecameEligible(listener: ((nodeId: string) => void) | undefined): void {
    this.becameEligibleListener = listener
  }

  /**
   * Notify the wake listener after registry state made a node eligible. The
   * transition already happened, so a listener error must not turn an accepted
   * register/heartbeat into a failed delivery (a replay would not fire again
   * because the node is now eligible).
   */
  private notifyBecameEligible(nodeId: string): void {
    try {
      this.becameEligibleListener?.(nodeId)
    } catch {
      // See the method comment: the registry operation already succeeded.
    }
  }

  /** Register a node. A duplicate id throws. The URL guard is the A2A transport's. */
  register(input: RemoteNodeRegistration): RemoteMeshNode {
    const { id, url, peerId, secret } = input
    if (!nonEmptyString(id)) throw new Error('Remote mesh node requires a non-empty id')
    if (!nonEmptyString(peerId)) throw new Error('Remote mesh node requires a non-empty peerId')
    if (!nonEmptyString(url)) throw new Error('Remote mesh node requires a non-empty url')
    assertSecret(secret)
    const capacity = capacityOf(input.capacity)
    if (this.nodes.has(id)) throw new Error(`Remote mesh node already registered: ${id}`)
    if (this.nodes.size >= this.maxNodes) throw new Error('Remote mesh node limit reached')

    // Reuse the transport's constructor (rather than duplicating its parse) so
    // an https-or-loopback-http guard can never drift. The throwaway instance
    // performs no I/O; the per-node transport is still created lazily.
    new A2AHttpTransport({ url, peerId, secret })
    assertNoUrlCredentials(url)

    const record: RemoteNodeRecord = {
      id,
      url,
      peerId,
      secret,
      capacity,
      capabilities: normalizeCapabilities(input.capabilities),
      online: true,
      lastHeartbeatAt: this.clock(),
    }
    this.nodes.set(id, record)
    // A successful register always inserts a brand-new eligible node. Treat it
    // as the ineligible → eligible transition the heartbeat path reports: a
    // late-bound node (registerRemoteNode / mesh inbox handleRegister) is the
    // production "a placeable node just appeared" event and must wake a parked
    // FIFO without waiting for an unrelated Worker turn. Failed registers throw
    // above, so they never reach this notification.
    this.notifyBecameEligible(id)
    return this.view(record, record.lastHeartbeatAt)
  }

  /**
   * Record a heartbeat. A heartbeat also brings an offline node back online.
   * Unknown ids return `false` instead of throwing. A heartbeat that makes an
   * ineligible node eligible again notifies the optional listener exactly once,
   * after the registry state is updated.
   */
  heartbeat(id: string, at: number = this.clock()): boolean {
    const node = this.nodes.get(id)
    if (!node) return false
    if (!Number.isFinite(at)) return false
    const now = this.clock()
    const wasEligible = this.eligible(node, now)
    node.lastHeartbeatAt = at
    node.online = true
    if (!wasEligible && this.eligible(node, now)) {
      this.notifyBecameEligible(id)
    }
    return true
  }

  /** Mark a node offline. Unknown ids return `false`. Assignments are kept. */
  markOffline(id: string): boolean {
    const node = this.nodes.get(id)
    if (!node) return false
    node.online = false
    return true
  }

  /** Remove a node, drop its cached transport, and release its assignments. */
  unregister(id: string): boolean {
    if (!this.nodes.delete(id)) return false
    this.transports.delete(id)
    for (const [ticketId, assigned] of this.assignments) {
      if (assigned === id) this.assignments.delete(ticketId)
    }
    return true
  }

  /**
   * Least-loaded eligible node for a ticket. A ticket keeps its node on repeat
   * picks while that node remains eligible. A stale/offline/unknown or
   * capability-mismatched assignment is released so its capacity is not leaked,
   * and the same call then keeps searching: it may assign another eligible node
   * or still return `undefined` when none is available.
   */
  pick(
    ticketId: string,
    now: number = this.clock(),
    requiredCapabilities: readonly string[] = [],
  ): RemoteMeshNode | undefined {
    if (!nonEmptyString(ticketId)) return undefined
    const at = finiteNow(now, this.clock())

    const assignedId = this.assignments.get(ticketId)
    if (assignedId !== undefined) {
      const assigned = this.nodes.get(assignedId)
      if (assigned && this.eligible(assigned, at)
        && capabilitiesMatch(assigned.capabilities, requiredCapabilities)) {
        return this.view(assigned, at)
      }
      // Release the ineligible sticky assignment, then fall through to the
      // least-loaded search below instead of stalling until a second pick.
      this.assignments.delete(ticketId)
    }

    let best: RemoteNodeRecord | undefined
    let bestLoad = Number.POSITIVE_INFINITY
    for (const node of this.nodes.values()) {
      if (!this.eligible(node, at)) continue
      if (!capabilitiesMatch(node.capabilities, requiredCapabilities)) continue
      const load = this.inFlight(node.id)
      if (load >= node.capacity || load >= bestLoad) continue
      best = node
      bestLoad = load
    }
    if (!best) return undefined
    this.assignments.set(ticketId, best.id)
    return this.view(best, at)
  }

  /** Release a ticket's node slot. Unknown tickets are a no-op `false`. */
  release(ticketId: string): boolean {
    return this.assignments.delete(ticketId)
  }

  /**
   * Rebuild a persisted sticky reservation without picking. Startup recovery
   * uses this to remember which peer ran an interrupted Assignment so a later
   * cancel can reach it. Unlike `pick`, it consults no eligibility, load, or
   * capacity: it restores pre-crash truth even when the peer is stale/offline
   * (the cancel itself stays fail-soft). An empty or unregistered node is a
   * no-op `false`; a ticket already bound to another node is left untouched.
   * Returns whether the ticket is bound to `nodeId` afterwards.
   */
  bind(ticketId: string, nodeId: string): boolean {
    if (!nonEmptyString(ticketId) || !nonEmptyString(nodeId)) return false
    if (!this.nodes.has(nodeId)) return false
    const assigned = this.assignments.get(ticketId)
    if (assigned !== undefined) return assigned === nodeId
    this.assignments.set(ticketId, nodeId)
    return true
  }

  /** Current assignment count for a node. */
  inFlight(nodeId: string): number {
    let count = 0
    for (const assigned of this.assignments.values()) {
      if (assigned === nodeId) count += 1
    }
    return count
  }

  /** Secret-free node copy, or `undefined` for an unknown id. */
  get(id: string, now: number = this.clock()): RemoteMeshNode | undefined {
    const node = this.nodes.get(id)
    return node ? this.view(node, finiteNow(now, this.clock())) : undefined
  }

  /** Secret-free copies of every registered node. */
  list(now: number = this.clock()): RemoteMeshNode[] {
    const at = finiteNow(now, this.clock())
    return [...this.nodes.values()].map(node => this.view(node, at))
  }

  /**
   * Send one `{ kind: 'assignment', ticketId, assignment }` envelope to the
   * node holding the ticket, after a successful `pick`. Returns `undefined`
   * when the ticket has no assignment or the node is stale/offline/unknown.
   *
   * `delivered` keeps the in-flight assignment. Any outcome after the send
   * settles, including `unroutable`, `failed`, a thrown transport, or an
   * invalid delivery, also keeps it: the caller owns the decision because the
   * ticket may already have moved on to a live replacement Assignment. Callers
   * must `release` when the failed dispatch should free the slot. No transport
   * error is ever thrown; the returned delivery never carries peer-supplied
   * error text or a secret.
   */
  async dispatch(ticketId: string, assignment: unknown): Promise<A2ADelivery | undefined> {
    if (!nonEmptyString(ticketId)) return undefined
    const nodeId = this.assignments.get(ticketId)
    if (nodeId === undefined) return undefined
    const node = this.nodes.get(nodeId)
    if (!node || !this.eligible(node, this.clock())) {
      // A stale/offline/unknown target must not keep capacity reserved.
      this.assignments.delete(ticketId)
      return undefined
    }

    const envelope: A2AEnvelope = {
      from: this.localPeerId,
      to: node.peerId,
      body: { kind: 'assignment', ticketId, assignment },
    }

    let transport: A2ATransport
    try {
      transport = this.transportFor(node)
    } catch {
      this.assignments.delete(ticketId)
      return failedDelivery(envelope)
    }

    let delivery: unknown
    try {
      delivery = await transport.send(envelope)
    } catch {
      // A remote transport may throw arbitrary text; never surface it.
      // The send settled: keep the sticky reservation so the caller can tell
      // a genuine failure from a late result for a replaced Assignment.
      return failedDelivery(envelope)
    }
    if (!isDelivery(delivery)) {
      return failedDelivery(envelope)
    }

    return safeDelivery(delivery)
  }

  hasTicketAssignment(ticketId: string): boolean {
    return this.assignments.has(ticketId)
  }

  /**
   * The node currently holding the ticket's sticky reservation, if any.
   *
   * Read-only: used to attribute an in-flight fail-soft `assignment_cancel` to
   * the node it targets, so a later dispatch to that same node can wait for it.
   * No placement, capacity, or cancel-transport behavior changes.
   */
  nodeFor(ticketId: string): string | undefined {
    return this.assignments.get(ticketId)
  }

  /**
   * Propagate ticket end / local cancel to the assigned remote worker inbox.
   *
   * `delivered` keeps the in-flight assignment. Any outcome after the send
   * settles, including `unroutable`, `failed`, a thrown transport, or an
   * invalid delivery, also keeps it: the caller owns the decision because the
   * ticket may already have moved on to a live replacement Assignment.
   *
   * By default (`release: true`), a stale/offline/unknown target or a transport
   * factory failure before the send drops the reservation. Pass
   * `{ release: false }` to keep the sticky assignment in those pre-send cases
   * too: a keep-slot cancel must never steal capacity from a live replacement
   * that already owns the ticket's slot, even when the old target is
   * unreachable. No transport error is ever thrown; the returned delivery never
   * carries peer-supplied error text or a secret.
   *
   * `opts.nodeId` targets a specific registered node instead of the Ticket's
   * current sticky reservation. Historical Assignment cancels use it so the
   * worker that still holds an older Assignment learns to stop it even after
   * the Ticket moved to a different remote node. An unknown or ineligible
   * explicit target stays fail-soft and never touches the live sticky slot.
   */
  async dispatchCancel(
    ticketId: string,
    assignmentId: string,
    opts?: { release?: boolean; nodeId?: string },
  ): Promise<A2ADelivery | undefined> {
    if (!nonEmptyString(ticketId) || !nonEmptyString(assignmentId)) return undefined
    const release = opts?.release ?? true
    const sticky = this.assignments.get(ticketId)
    const nodeId = opts?.nodeId ?? sticky
    if (nodeId === undefined) return undefined
    const node = this.nodes.get(nodeId)
    if (!node || !this.eligible(node, this.clock())) {
      // A keep-slot cancel must leave the sticky map alone even when the
      // assigned node is offline/stale/unknown. An explicit historical target
      // is not the sticky reservation, so it must never clear that slot.
      if (release && nodeId === sticky) this.assignments.delete(ticketId)
      return undefined
    }

    const envelope: A2AEnvelope = {
      from: this.localPeerId,
      to: node.peerId,
      body: { kind: 'assignment_cancel', ticketId, assignmentId },
    }

    let transport: A2ATransport
    try {
      transport = this.transportFor(node)
    } catch {
      // Same keep-assignment contract as the ineligible-target branch above:
      // only a releasing cancel frees the slot before the send, and only when
      // it targets the sticky reservation itself.
      if (release && nodeId === sticky) this.assignments.delete(ticketId)
      return failedDelivery(envelope)
    }

    let delivery: unknown
    try {
      delivery = await transport.send(envelope)
    } catch {
      // A remote transport may throw arbitrary text; never surface it.
      // The send settled: keep the sticky reservation so the caller can tell
      // a genuine failure from a late cancel for a replaced Assignment.
      return failedDelivery(envelope)
    }
    if (!isDelivery(delivery)) {
      return failedDelivery(envelope)
    }

    return safeDelivery(delivery)
  }

  private transportFor(node: RemoteNodeRecord): A2ATransport {
    const cached = this.transports.get(node.id)
    if (cached) return cached
    const transport = this.createTransport({
      url: node.url,
      peerId: this.localPeerId,
      secret: node.secret,
    })
    if (!transport || typeof transport.send !== 'function') {
      throw new Error('Remote mesh transport factory returned no send function')
    }
    this.transports.set(node.id, transport)
    return transport
  }

  private eligible(node: RemoteNodeRecord, now: number): boolean {
    return node.online && !this.isStale(node, now)
  }

  private isStale(node: RemoteNodeRecord, now: number): boolean {
    return now - node.lastHeartbeatAt > this.staleAfterMs
  }

  private view(node: RemoteNodeRecord, now: number): RemoteMeshNode {
    return {
      id: node.id,
      url: node.url,
      peerId: node.peerId,
      capacity: node.capacity,
      capabilities: [...node.capabilities],
      online: node.online,
      lastHeartbeatAt: node.lastHeartbeatAt,
      inFlight: this.inFlight(node.id),
      stale: this.isStale(node, now),
    }
  }
}

export interface RemoteMeshAssignmentEvent {
  /** Authenticated peer id. Never read from the body/`from` claim. */
  peerId: string
  ticketId: string
  assignment: unknown
  /** The authenticated A2A envelope (its `from` is the verified peer). */
  envelope: A2AEnvelope
}

export interface RemoteMeshAssignmentCancelEvent {
  peerId: string
  ticketId: string
  assignmentId: string
  envelope: A2AEnvelope
}

export interface RemoteMeshAssignmentResultEvent {
  peerId: string
  ticketId: string
  assignmentId: string
  report: unknown
  /** Stable idempotence key from the authenticated inbound request. */
  deliveryKey: string
  envelope: A2AEnvelope
}

export interface RemoteMeshHandlerOptions {
  /**
   * Registry to update for `register`/`heartbeat`. When omitted the inbox
   * creates its own registry using `localPeerId` (or `mesh-inbox`).
   */
  registry?: RemoteMeshRegistry
  /**
   * Synchronous callback seam for delivered assignments. It is invoked at most
   * once per accepted request. The `undefined` return type makes TypeScript
   * reject an `async` callback; a thrown error becomes a non-leaking 502.
   */
  onAssignment: (event: RemoteMeshAssignmentEvent) => undefined
  /**
   * Inbound cancel from the host router. When omitted, `assignment_cancel` bodies
   * fail closed like any unsupported kind.
   */
  onAssignmentCancel?: (event: RemoteMeshAssignmentCancelEvent) => undefined
  /**
   * Optional inbound worker results. When omitted, `assignment_result` bodies
   * fail closed like any unsupported kind.
   */
  onAssignmentResult?: (event: RemoteMeshAssignmentResultEvent) => undefined
  /** Inbound peer secret lookup, also used for the outbound registry entry. */
  resolveSecret: A2ASecretResolver
  /** Local identity; also the default inbox address. */
  localPeerId?: string
  /**
   * Optional address allowlist for inbound envelopes. When omitted the inbox
   * is address-agnostic: any authenticated non-empty `to` reaches the mesh
   * handler. This is a dedicated mesh endpoint, so `to` is not a privilege
   * boundary and is never trusted for identity.
   */
  address?: string | readonly string[]
  /** Maximum remote nodes this inbox accepts. Defaults to 256. */
  maxNodes?: number
  /** Maximum distinct inbound addresses this inbox binds. Defaults to 64. */
  maxAddresses?: number
  /**
   * Allow inbound `register` bodies to name loopback endpoints. Defaults to
   * `false`: a peer-supplied loopback URL would turn dispatch into a request
   * against local services. Tests and deliberate local deployments opt in.
   * Private-network reachability remains operator policy either way.
   */
  allowLoopbackRegistration?: boolean
  now?: () => number
  maxSkewMs?: number
  replayCache?: A2AReplayCache
  requestTimeoutMs?: number
}

/** A2A HTTP handler plus the registry/router it wraps. */
export type RemoteMeshHandler = A2AHttpHandler & {
  readonly registry: RemoteMeshRegistry
  readonly router: A2ARouter
}

function normalizedAddresses(address: string | readonly string[] | undefined): string[] {
  if (address === undefined) return []
  const values = typeof address === 'string' ? [address] : [...address]
  const unique = new Set<string>()
  for (const value of values) {
    if (nonEmptyString(value)) unique.add(value)
  }
  return [...unique]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/**
 * Receiver-side mesh inbox. It wraps `createA2AHttpHandler` with an
 * `A2ARouter`, accepts only `register`, `heartbeat`, and `assignment` bodies,
 * and treats the A2A-verified `envelope.from` as the authoritative peer id.
 *
 * It does not create a listener, construct a Trigger, or execute anything. The
 * caller mounts `handler` on its own `node:http` server.
 */
export class MeshInbox {
  readonly registry: RemoteMeshRegistry
  readonly router: A2ARouter
  readonly handler: RemoteMeshHandler
  private readonly options: RemoteMeshHandlerOptions
  private readonly restrictedAddresses: string[]
  private readonly maxNodes: number
  private readonly maxAddresses: number
  private readonly maxSkewMs: number
  private readonly allowLoopbackRegistration: boolean
  private readonly capturedSecrets = new Map<string, A2ASecret>()
  private readonly boundAddresses = new Set<string>()

  constructor(options: RemoteMeshHandlerOptions) {
    this.options = options
    this.maxNodes = boundedInteger(options.maxNodes, DEFAULT_REMOTE_MAX_NODES)
    this.maxAddresses = boundedInteger(options.maxAddresses, DEFAULT_REMOTE_MAX_ADDRESSES)
    this.allowLoopbackRegistration = options.allowLoopbackRegistration === true
    const skew = options.maxSkewMs ?? A2A_AUTH_MAX_SKEW_MS
    this.maxSkewMs = Number.isFinite(skew) && skew >= 0 ? Math.floor(skew) : A2A_AUTH_MAX_SKEW_MS
    this.registry = options.registry
      ?? new RemoteMeshRegistry({
        localPeerId: options.localPeerId ?? 'mesh-inbox',
        now: options.now,
        maxNodes: this.maxNodes,
      })
    this.router = new A2ARouter()
    this.restrictedAddresses = normalizedAddresses(options.address)
    if (this.restrictedAddresses.length > this.maxAddresses) {
      throw new Error('Remote mesh address limit reached')
    }

    const handle = (envelope: A2AEnvelope): void => { this.handleEnvelope(envelope) }
    for (const address of this.restrictedAddresses) {
      this.router.register(address, handle)
      this.boundAddresses.add(address)
    }

    // The dedicated mesh endpoint is address-agnostic unless the caller pins an
    // allowlist. Identity comes from A2A auth, not from `to` or the body.
    const router: Pick<A2ARouter, 'send'> = {
      send: (envelope: A2AEnvelope): A2ADelivery => {
        this.ensureAddress(envelope.to)
        return this.router.send(envelope)
      },
    }

    const base = createA2AHttpHandler({
      router,
      resolveSecret: async (peerId: string) => {
        const secret = await options.resolveSecret(peerId)
        if (secret === undefined) this.capturedSecrets.delete(peerId)
        else this.capturedSecrets.set(peerId, secret)
        return secret
      },
      now: options.now,
      maxSkewMs: options.maxSkewMs,
      replayCache: options.replayCache,
      requestTimeoutMs: options.requestTimeoutMs,
    })
    this.handler = Object.assign(base, {
      registry: this.registry,
      router: this.router,
    }) as RemoteMeshHandler
  }

  private ensureAddress(to: unknown): void {
    if (this.restrictedAddresses.length > 0) return
    if (!nonEmptyString(to) || this.boundAddresses.has(to)) return
    if (this.boundAddresses.size >= this.maxAddresses) {
      throw new Error('Remote mesh address limit reached')
    }
    this.boundAddresses.add(to)
    this.router.register(to, (envelope: A2AEnvelope): void => { this.handleEnvelope(envelope) })
  }

  private handleEnvelope(envelope: A2AEnvelope): void {
    // `createA2AHttpHandler` sets `from` to the authenticated peer id; any body
    // `from` claim was already rejected or dropped. Treat it as authoritative.
    const peerId = envelope.from
    if (!nonEmptyString(peerId)) throw new Error('mesh envelope has no authenticated peer')
    const body = envelope.body
    if (!isRecord(body)) throw new Error('mesh body must be an object')

    switch (body.kind) {
      case 'register':
        this.handleRegister(peerId, body)
        return
      case 'heartbeat':
        this.handleHeartbeat(peerId, body)
        return
      case 'assignment':
        this.handleAssignment(peerId, body, envelope)
        return
      case 'assignment_cancel':
        this.handleAssignmentCancel(peerId, body, envelope)
        return
      case 'assignment_result':
        this.handleAssignmentResult(peerId, body, envelope)
        return
      default:
        // Unknown kinds are a failed delivery (HTTP 502) and never reach the
        // assignment callback.
        throw new Error('unsupported mesh body kind')
    }
  }

  private handleRegister(peerId: string, body: Record<string, unknown>): void {
    if (!nonEmptyString(body.url)) throw new Error('mesh register requires a url')
    const url = body.url
    if (!this.allowLoopbackRegistration) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error('mesh register has an invalid url')
      }
      // An authenticated peer must not be able to point our outbound dispatch
      // at arbitrary local services. Private-network policy stays with the
      // operator; this module only closes the loopback default.
      if (isLoopbackHostname(parsed.hostname)) {
        throw new Error('mesh register rejects loopback endpoints')
      }
    }
    const requestedId = body.id ?? body.nodeId
    if (requestedId !== undefined && !nonEmptyString(requestedId)) {
      throw new Error('mesh register has an invalid node id')
    }
    const id = nonEmptyString(requestedId) ? requestedId : peerId
    const capacity = body.capacity
    if (capacity !== undefined
      && (typeof capacity !== 'number' || !Number.isSafeInteger(capacity) || capacity < 1)) {
      throw new Error('mesh register has an invalid capacity')
    }
    const secret = this.capturedSecrets.get(peerId)
    if (!secret) throw new Error('mesh register has no resolvable peer secret')
    // Bound remote-driven registry growth even when the caller supplied an
    // unbounded registry. A duplicate id is left for the registry to reject.
    if (!this.registry.get(id) && this.registry.list().length >= this.maxNodes) {
      throw new Error('Remote mesh node limit reached')
    }
    this.registry.register({
      id,
      url,
      peerId,
      secret,
      capacity: capacity as number | undefined,
      capabilities: normalizeCapabilities(body.capabilities),
    })
  }

  private handleHeartbeat(peerId: string, body: Record<string, unknown>): void {
    const requestedId = body.id ?? body.nodeId
    if (requestedId !== undefined && !nonEmptyString(requestedId)) {
      throw new Error('mesh heartbeat has an invalid node id')
    }
    const id = this.nodeIdForPeer(peerId, nonEmptyString(requestedId) ? requestedId : undefined)
    const at = body.at
    if (at !== undefined
      && (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0)) {
      throw new Error('mesh heartbeat has an invalid timestamp')
    }
    if (typeof at === 'number') {
      const now = this.options.now ? this.options.now() : Date.now()
      const current = Number.isFinite(now) ? now : Date.now()
      if (at > current + this.maxSkewMs) {
        // A peer must not be able to pin itself online indefinitely.
        throw new Error('mesh heartbeat timestamp is too far in the future')
      }
    }
    if (!this.registry.heartbeat(id, at as number | undefined)) {
      throw new Error('mesh heartbeat targets an unknown node')
    }
  }

  private handleAssignment(
    peerId: string,
    body: Record<string, unknown>,
    envelope: A2AEnvelope,
  ): void {
    if (!nonEmptyString(body.ticketId)) throw new Error('mesh assignment requires a ticketId')
    if (!hasOwn(body, 'assignment')) throw new Error('mesh assignment requires an assignment body')
    const event: RemoteMeshAssignmentEvent = {
      peerId,
      ticketId: body.ticketId,
      assignment: body.assignment,
      envelope,
    }
    // Exactly once per accepted request. The A2A router calls this handler once.
    const callback = this.options.onAssignment
    // The HTTP router seam is synchronous. Reject a known async function before
    // invoking it so its body cannot keep running after we report failure.
    if ((callback as unknown as { constructor?: { name?: string } })
      .constructor?.name === 'AsyncFunction') {
      throw new Error('mesh assignment callback must be synchronous')
    }
    const result: unknown = callback(event)
    if (result !== undefined) {
      if (result !== null && typeof (result as PromiseLike<unknown>).then === 'function') {
        // Defensive for JS/cast callers: the callback escaped the typed
        // synchronous contract. Swallow the rejection and fail the delivery.
        void Promise.resolve(result).catch(() => {})
      }
      throw new Error('mesh assignment callback must be synchronous')
    }
  }

  private handleAssignmentCancel(
    peerId: string,
    body: Record<string, unknown>,
    envelope: A2AEnvelope,
  ): void {
    const callback = this.options.onAssignmentCancel
    if (!callback) throw new Error('unsupported mesh body kind')
    if (!nonEmptyString(body.ticketId)) throw new Error('mesh assignment_cancel requires a ticketId')
    if (!nonEmptyString(body.assignmentId)) throw new Error('mesh assignment_cancel requires an assignmentId')
    const event: RemoteMeshAssignmentCancelEvent = {
      peerId,
      ticketId: body.ticketId,
      assignmentId: body.assignmentId,
      envelope,
    }
    if ((callback as unknown as { constructor?: { name?: string } })
      .constructor?.name === 'AsyncFunction') {
      throw new Error('mesh assignment_cancel callback must be synchronous')
    }
    const result: unknown = callback(event)
    if (result !== undefined) {
      if (result !== null && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(() => {})
      }
      throw new Error('mesh assignment_cancel callback must be synchronous')
    }
  }

  private handleAssignmentResult(
    peerId: string,
    body: Record<string, unknown>,
    envelope: A2AEnvelope,
  ): void {
    const callback = this.options.onAssignmentResult
    if (!callback) throw new Error('unsupported mesh body kind')
    if (!nonEmptyString(body.ticketId)) throw new Error('mesh assignment_result requires a ticketId')
    if (!nonEmptyString(body.assignmentId)) throw new Error('mesh assignment_result requires an assignmentId')
    if (!hasOwn(body, 'report')) throw new Error('mesh assignment_result requires a report')
    // The transport mints a fresh envelope id on every send, so it cannot be an
    // idempotence key: a retry would look like a new result. Require the worker
    // to send the same `deliveryKey` on retries and a distinct key per logical
    // result.
    if (!nonEmptyString(body.deliveryKey)) {
      throw new Error('mesh assignment_result requires a deliveryKey')
    }
    const deliveryKey = body.deliveryKey
    const event: RemoteMeshAssignmentResultEvent = {
      peerId,
      ticketId: body.ticketId,
      assignmentId: body.assignmentId,
      report: body.report,
      deliveryKey,
      envelope,
    }
    if ((callback as unknown as { constructor?: { name?: string } })
      .constructor?.name === 'AsyncFunction') {
      throw new Error('mesh assignment_result callback must be synchronous')
    }
    const result: unknown = callback(event)
    if (result !== undefined) {
      if (result !== null && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(() => {})
      }
      throw new Error('mesh assignment_result callback must be synchronous')
    }
  }

  private nodeIdForPeer(peerId: string, requestedId: string | undefined): string {
    if (requestedId !== undefined) {
      const node = this.registry.get(requestedId)
      if (!node || node.peerId !== peerId) throw new Error('mesh node does not belong to this peer')
      return requestedId
    }
    if (this.registry.get(peerId)) return peerId
    const matches = this.registry.list().filter(node => node.peerId === peerId)
    if (matches.length === 1 && matches[0]) return matches[0].id
    throw new Error('mesh heartbeat targets an unknown node')
  }
}

/**
 * Build a receiver handler for the remote mesh without starting a listener.
 * The caller creates the `node:http` server.
 */
export function createRemoteMeshHandler(options: RemoteMeshHandlerOptions): RemoteMeshHandler {
  return new MeshInbox(options).handler
}
