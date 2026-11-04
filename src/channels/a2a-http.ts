import type { IncomingMessage, ServerResponse } from 'node:http'
import type { A2ADelivery, A2AEnvelope, A2ARouter } from './a2a.ts'
import type { A2ATransport } from './a2a-transport.ts'
import {
  createA2AReplayCache,
  inspectA2ARequest,
  isA2ASecret,
  signA2ARequest,
  verifyA2ARequest,
  type A2AReplayCache,
  type A2ASecret,
} from './a2a-auth.ts'

/**
 * HTTP half of the A2A transport (T50 network boundary).
 *
 * This file exposes a request handler and a client transport. It does NOT
 * start a listener: the process owner must call `node:http`'s `createServer`
 * with the handler and decide where/whether to bind it. No key is stored here
 * either; inbound keys come from `resolveSecret`, outbound keys from the
 * transport constructor.
 *
 * Security properties:
 * - The authenticated peer id, never the JSON `from` field, is authoritative.
 *   A conflicting `from` is rejected.
 * - Unknown wire fields are dropped; only `from`/`to`/`body` reach the router.
 * - Secrets and signatures are never logged, returned, or placed in errors.
 * - Delivery goes through `A2ARouter.send`; this adapter never builds a
 *   Trigger and never bypasses the ingress boundary.
 *
 * MULTI-NODE DEPLOYMENT REQUIREMENT
 * The signed canonical string binds the peer and body, not the target host,
 * path, or method, and replay caches are process-local by default. A mesh that
 * shares one peer secret across verifiers lets a captured request replay to a
 * different node within ±60 s. Operators MUST use a unique secret per verifier
 * node and/or pass one shared `replayCache` to every handler that shares a
 * secret. See `a2a-auth.ts` for the full requirement.
 *
 * The outbound transport only accepts `https:` URLs, or `http:` on a loopback
 * host for local tests/processes. Redirects are refused, and responses must be
 * JSON within a byte cap before they are trusted.
 */

export const A2A_HTTP_PATH = '/a2a'
export const A2A_HTTP_MAX_BODY_BYTES = 64 * 1024
/** Outbound delivery responses are JSON and must fit this cap. */
export const A2A_HTTP_MAX_RESPONSE_BYTES = 128 * 1024
/** Default inbound absolute/inactivity and outbound request timeout. */
export const A2A_HTTP_DEFAULT_TIMEOUT_MS = 30_000

const JSON_CONTENT_TYPE = 'application/json'

export type A2ASecretResolver = (
  peerId: string,
) => A2ASecret | undefined | Promise<A2ASecret | undefined>

export interface A2AHttpHandlerOptions {
  /** The trusted local ingress. Only `send` is used. */
  router: Pick<A2ARouter, 'send'>
  /** Per-peer shared secret lookup. An unknown peer or missing key is a 401. */
  resolveSecret: A2ASecretResolver
  /** Verifier clock (epoch ms). Injectable for deterministic tests. */
  now?: () => number
  /** Allowed timestamp skew. Defaults to the auth module's ±60 s. */
  maxSkewMs?: number
  /** Replay cache shared by all requests to this handler. */
  replayCache?: A2AReplayCache
  /**
   * Inbound request budget in milliseconds. It is both an absolute deadline
   * from handler entry and a socket-inactivity timeout. On expiry the request
   * is destroyed and an in-flight `resolveSecret` is abandoned. Defaults to
   * 30 s.
   */
  requestTimeoutMs?: number
}

export type A2AHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export interface A2AHttpTransportOptions {
  /** Full endpoint URL, e.g. `http://127.0.0.1:8080/a2a`. */
  url: string
  /** The local authenticated identity presented to the remote verifier. */
  peerId: string
  /** Shared secret for this peer. Never logged. */
  secret: A2ASecret
  /** Injectable fetch for tests. Defaults to the runtime's global fetch. */
  fetch?: typeof globalThis.fetch
  /**
   * End-to-end request timeout in milliseconds. The request is aborted and a
   * failed delivery is returned. Defaults to 30 s.
   */
  timeoutMs?: number
}

class BodyTooLargeError extends Error {
  constructor() {
    super('A2A request body is too large')
    this.name = 'BodyTooLargeError'
  }
}

class RequestTimeoutError extends Error {
  constructor() {
    super('A2A request timed out')
    this.name = 'RequestTimeoutError'
  }
}

class ResponseTooLargeError extends Error {
  constructor() {
    super('A2A response is too large')
    this.name = 'ResponseTooLargeError'
  }
}

function positiveTimeout(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  return A2A_HTTP_DEFAULT_TIMEOUT_MS
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * Fail closed on endpoints that cannot protect the peer secret in transit.
 * Plain HTTP is allowed only to a loopback host (local process/tests).
 */
function assertAllowedEndpoint(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('A2A HTTP transport requires an absolute URL')
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return
  throw new Error('A2A HTTP transport requires https or a loopback http URL')
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': JSON_CONTENT_TYPE,
      'content-length': Buffer.byteLength(body, 'utf8'),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  } catch {
    // The client may have gone away; fail closed without logging or leaking.
    res.destroy()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isJsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers['content-type']
  if (typeof raw !== 'string') return false
  return raw.split(';', 1)[0]!.trim().toLowerCase() === JSON_CONTENT_TYPE
}

function declaredBodyTooLarge(req: IncomingMessage): boolean {
  const raw = req.headers['content-length']
  if (typeof raw !== 'string' || !/^\d+$/u.test(raw)) return false
  return Number(raw) > A2A_HTTP_MAX_BODY_BYTES
}

function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks: Buffer[] = []

    function cleanup(): void {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }

    function settle(finish: () => void): void {
      if (settled) return
      settled = true
      cleanup()
      finish()
    }

    function onData(chunk: Buffer): void {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settle(() => reject(new BodyTooLargeError()))
        // Drain the rest so the client can read the 400 response.
        req.resume()
        return
      }
      chunks.push(chunk)
    }

    function onEnd(): void {
      settle(() => resolve(Buffer.concat(chunks)))
    }

    function onError(error: Error): void {
      settle(() => reject(error))
    }

    function onAborted(): void {
      settle(() => reject(new Error('A2A request aborted')))
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

/**
 * Build a Node request handler for `POST /a2a`.
 *
 * Fail-closed status policy:
 * - 401: unknown peer, missing/malformed auth headers, bad signature, skew,
 *   replay, or an unresolvable secret.
 * - 400: wrong content type, oversize body, invalid JSON, invalid envelope, or
 *   a `from` value that claims another identity.
 * - 404: unknown target (`unroutable`); 502: router/handler failure.
 * Error responses are generic and never echo the body or secret.
 */
export function createA2AHttpHandler(options: A2AHttpHandlerOptions): A2AHttpHandler {
  const replayCache = options.replayCache
    ?? createA2AReplayCache({ windowMs: options.maxSkewMs })
  const requestTimeoutMs = positiveTimeout(options.requestTimeoutMs)

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Inactivity guard: a stalled socket is destroyed, and an idle keep-alive
    // socket is not destroyed after a completed response.
    req.setTimeout(requestTimeoutMs, () => { req.destroy() })

    // Absolute deadline from handler entry. Unlike the inactivity timeout, a
    // one-byte-per-interval drip cannot extend it. It also bounds a hanging
    // `resolveSecret`; the request is destroyed when it expires.
    let rejectDeadline!: (error: Error) => void
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject
    })
    const absoluteTimer = setTimeout(() => {
      req.destroy()
      rejectDeadline(new RequestTimeoutError())
    }, requestTimeoutMs)
    const clearDeadline = (): void => {
      clearTimeout(absoluteTimer)
      req.setTimeout(0)
    }
    res.once('finish', clearDeadline)
    res.once('close', clearDeadline)
    // Some early-return paths never race this promise; keep its rejection
    // handled while preserving the same rejected promise for Promise.race.
    void deadline.catch(() => {})

    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://a2a.invalid').pathname
    } catch {
      pathname = ''
    }
    if (pathname !== A2A_HTTP_PATH) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonContentType(req)) {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    const now = options.now ? options.now() : Date.now()

    // Header/clock shape is checked before any body bytes are buffered, so
    // malformed, skewed, or unknown peers cannot consume the 64 KiB cap.
    let shape: ReturnType<typeof inspectA2ARequest>
    try {
      shape = inspectA2ARequest({
        headers: req.headers,
        now,
        maxSkewMs: options.maxSkewMs,
      })
    } catch {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const peerId = shape.peerId

    let secret: A2ASecret | undefined
    try {
      const resolving = options.resolveSecret(peerId)
      secret = await Promise.race([Promise.resolve(resolving), deadline])
    } catch {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    if (!isA2ASecret(secret)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    if (declaredBodyTooLarge(req)) {
      req.resume()
      sendJson(res, 400, { error: 'bad request' })
      return
    }

    let raw: Buffer
    try {
      raw = await Promise.race([readRawBody(req, A2A_HTTP_MAX_BODY_BYTES), deadline])
    } catch {
      sendJson(res, 400, { error: 'bad request' })
      return
    }

    try {
      verifyA2ARequest({
        headers: req.headers,
        body: raw,
        secret,
        now,
        maxSkewMs: options.maxSkewMs,
        replayCache,
      })
    } catch {
      // Auth failures and resolver misconfiguration all fail closed as 401.
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    if (!isRecord(parsed) || !hasOwn(parsed, 'body')) {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    const to = parsed.to
    if (typeof to !== 'string' || to.trim().length === 0) {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    const claimedFrom = parsed.from
    if (claimedFrom !== undefined && claimedFrom !== peerId) {
      // A peer may omit `from` or repeat its authenticated identity. It may
      // never claim a different identity, and the claim is never normalized.
      sendJson(res, 400, { error: 'bad request' })
      return
    }

    // Only protocol fields cross into the router; `id`/`at`/`human` and any
    // other caller-supplied keys are dropped. The authenticated id is used.
    const envelope: A2AEnvelope = { from: peerId, to, body: parsed.body }

    let delivery: A2ADelivery
    try {
      delivery = options.router.send(envelope)
    } catch {
      sendJson(res, 502, { error: 'delivery failed' })
      return
    }

    if (delivery.status === 'delivered') {
      sendJson(res, 200, delivery)
      return
    }
    if (delivery.status === 'unroutable') {
      // Return the delivery so the HTTP client can preserve the status.
      sendJson(res, 404, delivery)
      return
    }
    // `failed` can carry a router/handler error message; do not leak it.
    sendJson(res, 502, { error: 'delivery failed' })
  }

  return async (req, res) => {
    try {
      await handle(req, res)
    } catch {
      // Last-resort fail-closed response. No error text is exposed.
      sendJson(res, 400, { error: 'bad request' })
    }
  }
}

function isDelivery(value: unknown): value is A2ADelivery {
  if (!isRecord(value)) return false
  if (value.status !== 'delivered' && value.status !== 'unroutable' && value.status !== 'failed') {
    return false
  }
  if (typeof value.delivered !== 'number'
    || !Number.isInteger(value.delivered)
    || value.delivered < 0) {
    return false
  }
  if (typeof value.persisted !== 'boolean') return false
  if (value.error !== undefined && typeof value.error !== 'string') return false
  const envelope = value.envelope
  if (!isRecord(envelope)) return false
  if (typeof envelope.from !== 'string' || envelope.from.length === 0) return false
  if (typeof envelope.to !== 'string' || envelope.to.length === 0) return false
  if (!hasOwn(envelope, 'body')) return false
  return true
}

function deliveryMatchesRequest(delivery: A2ADelivery, envelope: A2AEnvelope): boolean {
  return delivery.envelope.from === envelope.from && delivery.envelope.to === envelope.to
}

async function readResponseBytes(
  response: Awaited<ReturnType<typeof globalThis.fetch>>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new ResponseTooLargeError()
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > maxBytes) throw new ResponseTooLargeError()
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A cancelled/errored stream may already be released.
    }
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function failedDelivery(envelope: A2AEnvelope, error: string): A2ADelivery {
  return { envelope, status: 'failed', delivered: 0, persisted: false, error }
}

/**
 * Client-side HTTP A2A transport. It signs the exact JSON body it sends and
 * returns the server's delivery result. A rejected request resolves to a
 * `failed` delivery; it never throws the server's error text.
 */
export class A2AHttpTransport implements A2ATransport {
  private readonly url: string
  private readonly peerId: string
  private readonly secret: A2ASecret
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(options: A2AHttpTransportOptions) {
    // Fail closed unless the peer secret is protected in transit. Plain HTTP
    // is only permitted for loopback local processes and tests.
    assertAllowedEndpoint(options.url)
    this.url = options.url
    this.peerId = options.peerId
    this.secret = options.secret
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = positiveTimeout(options.timeoutMs)
  }

  async send(envelope: A2AEnvelope): Promise<A2ADelivery> {
    if (envelope.from !== this.peerId) {
      // The transport signs as `this.peerId`; a different claimed sender would
      // be rejected remotely. Fail locally instead of rewriting identity.
      return failedDelivery(envelope, 'A2A envelope sender does not match the authenticated peer')
    }

    let payload: string
    try {
      // The wire envelope is exactly { from, to, body }; unknown fields drop.
      payload = JSON.stringify({ from: envelope.from, to: envelope.to, body: envelope.body })
    } catch {
      return failedDelivery(envelope, 'A2A envelope is not serializable')
    }

    let signed: ReturnType<typeof signA2ARequest>
    try {
      signed = signA2ARequest({
        peerId: this.peerId,
        secret: this.secret,
        body: payload,
      })
    } catch {
      return failedDelivery(envelope, 'A2A request could not be signed')
    }

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new RequestTimeoutError())
      }, this.timeoutMs)
    })

    let response: Awaited<ReturnType<typeof globalThis.fetch>> | undefined
    let parsed: unknown
    try {
      response = await Promise.race([
        this.fetchImpl(this.url, {
          method: 'POST',
          headers: {
            'content-type': JSON_CONTENT_TYPE,
            ...signed.headers,
          },
          body: payload,
          signal: controller.signal,
          // A redirect could silently move the signed request to an
          // untrusted endpoint; refuse instead of following it.
          redirect: 'error',
        }),
        deadline,
      ])

      const mediaType = (response.headers.get('content-type') ?? '')
        .split(';', 1)[0]!
        .trim()
        .toLowerCase()
      if (mediaType !== JSON_CONTENT_TYPE) {
        return failedDelivery(envelope, 'A2A response was not JSON')
      }

      // Keep the timer and abort signal alive through the body read. A peer
      // can send headers and then stall the JSON payload forever.
      const bytes = await Promise.race([
        readResponseBytes(response, A2A_HTTP_MAX_RESPONSE_BYTES),
        deadline,
      ])
      try {
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
      } catch {
        return failedDelivery(envelope, 'A2A response was invalid')
      }
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        return failedDelivery(envelope, 'A2A response was too large')
      }
      return failedDelivery(
        envelope,
        timedOut ? 'A2A request timed out' : 'A2A request failed',
      )
    } finally {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
    if (!response) return failedDelivery(envelope, 'A2A response was invalid')

    // Trust a response only when both the HTTP status and the validated
    // delivery agree, and when its envelope matches what this transport sent.
    if (response.status === 200
      && isDelivery(parsed)
      && parsed.status === 'delivered'
      && deliveryMatchesRequest(parsed, envelope)) {
      return parsed
    }
    if (response.status === 404
      && isDelivery(parsed)
      && parsed.status === 'unroutable'
      && deliveryMatchesRequest(parsed, envelope)) {
      return parsed
    }
    if (!response.ok) {
      return failedDelivery(envelope, `A2A request failed with status ${response.status}`)
    }
    return failedDelivery(envelope, 'A2A response was invalid')
  }
}
