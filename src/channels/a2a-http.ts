import type { IncomingMessage, ServerResponse } from 'node:http'
import type { A2ADelivery, A2AEnvelope, A2ARouter } from './a2a.ts'
import type { A2ATransport } from './a2a-transport.ts'
import {
  A2AAuthError,
  createA2AReplayCache,
  readA2APeerId,
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
 */

export const A2A_HTTP_PATH = '/a2a'
export const A2A_HTTP_MAX_BODY_BYTES = 64 * 1024

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
}

class BodyTooLargeError extends Error {
  constructor() {
    super('A2A request body is too large')
    this.name = 'BodyTooLargeError'
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': JSON_CONTENT_TYPE,
      'content-length': Buffer.byteLength(body, 'utf8'),
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    if (declaredBodyTooLarge(req)) {
      req.resume()
      sendJson(res, 400, { error: 'bad request' })
      return
    }

    let raw: Buffer
    try {
      raw = await readRawBody(req, A2A_HTTP_MAX_BODY_BYTES)
    } catch {
      sendJson(res, 400, { error: 'bad request' })
      return
    }

    const peerId = readA2APeerId(req.headers)
    if (!peerId) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    let secret: A2ASecret | undefined
    try {
      secret = await options.resolveSecret(peerId)
    } catch {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    if (secret === undefined) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    try {
      verifyA2ARequest({
        headers: req.headers,
        body: raw,
        secret,
        now: options.now?.(),
        maxSkewMs: options.maxSkewMs,
        replayCache,
      })
    } catch (error) {
      // Auth failures and resolver misconfiguration all fail closed as 401.
      if (error instanceof A2AAuthError) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
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
  if (typeof value.delivered !== 'number' || typeof value.persisted !== 'boolean') return false
  return isRecord(value.envelope)
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

  constructor(options: A2AHttpTransportOptions) {
    this.url = options.url
    this.peerId = options.peerId
    this.secret = options.secret
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async send(envelope: A2AEnvelope): Promise<A2ADelivery> {
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

    let response: Awaited<ReturnType<typeof globalThis.fetch>>
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': JSON_CONTENT_TYPE,
          ...signed.headers,
        },
        body: payload,
      })
    } catch {
      return failedDelivery(envelope, 'A2A request failed')
    }

    let result: unknown
    try {
      result = await response.json()
    } catch {
      result = undefined
    }
    if (isDelivery(result)) return result
    if (!response.ok) {
      return failedDelivery(envelope, `A2A request failed with status ${response.status}`)
    }
    return failedDelivery(envelope, 'A2A response was invalid')
  }
}
