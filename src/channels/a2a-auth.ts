import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Wire authentication for the HTTP A2A transport (T50 network boundary).
 *
 * The scheme is deliberately small and dependency-free: every request carries
 * a peer id, an epoch-millisecond timestamp, a single-use nonce, and an
 * HMAC-SHA256 over a canonical LF-separated string. Verification is
 * fail-closed and never puts the shared secret or the supplied signature in an
 * error message.
 *
 * This module only defines the primitives. It opens no listener and stores no
 * keys; secret distribution and rotation remain an operator concern.
 */

export const A2A_AUTH_HEADERS = {
  peer: 'x-ds-peer',
  timestamp: 'x-ds-timestamp',
  nonce: 'x-ds-nonce',
  signature: 'x-ds-signature',
} as const

/** Requests whose timestamp is farther than this from the verifier clock fail. */
export const A2A_AUTH_MAX_SKEW_MS = 60_000

/** Default bounded replay cache size. */
const DEFAULT_REPLAY_CACHE_ENTRIES = 10_000

/** Peer ids are authenticated identities, not display names: no whitespace/control characters. */
const PEER_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,200}$/u
const TIMESTAMP_PATTERN = /^\d{1,16}$/u
const NONCE_PATTERN = /^[0-9a-fA-F]{32,}$/u
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/u

export type A2AHeaderBag = Record<string, string | readonly string[] | undefined>
export type A2ASecret = string | Uint8Array
export type A2ABodyBytes = string | Uint8Array

export type A2AAuthErrorCode =
  | 'missing_header'
  | 'malformed_header'
  | 'unknown_peer'
  | 'invalid_secret'
  | 'invalid_signature'
  | 'timestamp_skew'
  | 'replay'

/** Typed authentication failure. Messages are static and never contain input data. */
export class A2AAuthError extends Error {
  readonly code: A2AAuthErrorCode

  constructor(code: A2AAuthErrorCode, message: string) {
    super(message)
    this.name = 'A2AAuthError'
    this.code = code
  }
}

export interface A2ASignInput {
  peerId: string
  secret: A2ASecret
  /** Raw request body bytes; the string form is encoded as UTF-8. */
  body: A2ABodyBytes
  /** Unix epoch milliseconds. Defaults to the current clock. */
  timestamp?: number
  /** At least 32 hex characters. Defaults to a fresh 128-bit nonce. */
  nonce?: string
}

export interface A2ASignedRequest {
  headers: Record<string, string>
  canonical: string
}

export interface A2AVerifyInput {
  headers: A2AHeaderBag
  /** Raw request body bytes; must be the exact bytes that were signed. */
  body: A2ABodyBytes
  /** Shared secret, or use `resolveSecret` to look it up by authenticated peer id. */
  secret?: A2ASecret
  resolveSecret?: (peerId: string) => A2ASecret | undefined
  /** Verifier clock in epoch milliseconds. Defaults to `Date.now()`. */
  now?: number
  /** Allowed clock skew. Defaults to `A2A_AUTH_MAX_SKEW_MS`. */
  maxSkewMs?: number
  /** Replay cache. When omitted a bounded process-local cache is used. */
  replayCache?: A2AReplayCache
}

export interface A2AVerifiedRequest {
  /** The authenticated peer id. This is authoritative over any body `from` field. */
  peerId: string
}

export interface A2AReplayCacheOptions {
  /** Maximum retained nonces. Oldest insertions are evicted first. */
  maxEntries?: number
  /** How long a nonce is remembered after its request timestamp. */
  windowMs?: number
}

export interface A2AReplayCache {
  /** Current retained entries (expired entries are pruned before the read). */
  readonly size: number
  /**
   * Atomically test and remember `(peerId, nonce)`. Returns `false` when the
   * nonce is already within the window. `timestamp` is the signed request
   * timestamp; the entry expires `windowMs` after it.
   */
  checkAndAdd(peerId: string, nonce: string, timestamp: number, now?: number): boolean
  prune(now?: number): void
}

function replayKey(peerId: string, nonce: string): string {
  // Peer ids cannot contain NUL/control characters, so this cannot collide.
  return `${peerId}\u0000${nonce}`
}

/**
 * Bounded, self-pruning nonce cache. Entries are keyed by authenticated peer
 * and nonce, so two peers may use the same nonce value. Expired entries are
 * removed on every check and a hard size bound drops the oldest insertions.
 */
export function createA2AReplayCache(options: A2AReplayCacheOptions = {}): A2AReplayCache {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_REPLAY_CACHE_ENTRIES))
  const windowMs = Math.max(1, Math.floor(options.windowMs ?? A2A_AUTH_MAX_SKEW_MS))
  const entries = new Map<string, number>()

  const prune = (now = Date.now()): void => {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(key)
    }
  }

  return {
    get size(): number {
      // Reads are cheap and side-effect free; `checkAndAdd` and `prune` own
      // expiry so an injected test clock cannot be confused with wall time.
      return entries.size
    },
    checkAndAdd(peerId: string, nonce: string, timestamp: number, now = Date.now()): boolean {
      prune(now)
      const key = replayKey(peerId, nonce)
      if (entries.has(key)) return false
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
      entries.set(key, timestamp + windowMs)
      return true
    },
    prune,
  }
}

const defaultReplayCache = createA2AReplayCache()

function peerIdOf(headers: A2AHeaderBag): string {
  const value = requiredHeader(headers, A2A_AUTH_HEADERS.peer)
  if (!PEER_ID_PATTERN.test(value)) {
    throw new A2AAuthError('malformed_header', 'malformed A2A peer header')
  }
  return value
}

/**
 * Read and validate the authenticated peer id without verifying the request.
 * The HTTP handler uses this to resolve the per-peer secret; the full
 * verification path still re-reads and re-validates the header.
 */
export function readA2APeerId(headers: A2AHeaderBag): string | undefined {
  try {
    return peerIdOf(headers)
  } catch {
    return undefined
  }
}

type HeaderRead =
  | { ok: true; value: string }
  | { ok: false; reason: 'missing' | 'malformed' }

function readHeader(headers: A2AHeaderBag, name: string): HeaderRead {
  let matches = 0
  let raw: string | readonly string[] | undefined
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue
    matches += 1
    raw = headers[key]
  }
  if (matches === 0) return { ok: false, reason: 'missing' }
  if (matches > 1) return { ok: false, reason: 'malformed' }
  if (typeof raw === 'string') {
    return raw.length > 0 ? { ok: true, value: raw } : { ok: false, reason: 'malformed' }
  }
  if (Array.isArray(raw)) {
    if (raw.length === 1 && typeof raw[0] === 'string' && raw[0].length > 0) {
      return { ok: true, value: raw[0] }
    }
    return { ok: false, reason: 'malformed' }
  }
  return { ok: false, reason: 'malformed' }
}

function requiredHeader(headers: A2AHeaderBag, name: string): string {
  const result = readHeader(headers, name)
  if (result.ok) return result.value
  if (result.reason === 'missing') {
    throw new A2AAuthError('missing_header', 'missing A2A authentication header')
  }
  throw new A2AAuthError('malformed_header', 'malformed A2A authentication header')
}

function bytesOf(value: A2ABodyBytes): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new A2AAuthError('malformed_header', 'A2A body must be bytes')
}

function secretBytes(value: A2ASecret): Buffer {
  const bytes = typeof value === 'string'
    ? Buffer.from(value, 'utf8')
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : undefined
  if (!bytes || bytes.length === 0) {
    throw new A2AAuthError('invalid_secret', 'A2A peer secret is not configured')
  }
  return bytes
}

function canonicalString(
  peerId: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): string {
  const digest = createHash('sha256').update(body).digest('hex')
  return `v1\n${peerId}\n${timestamp}\n${nonce}\n${digest}`
}

function signCanonical(secret: A2ASecret, canonical: string): string {
  return createHmac('sha256', secretBytes(secret)).update(canonical, 'utf8').digest('hex')
}

/** Signs one HTTP A2A request. Never includes the secret in the result. */
export function signA2ARequest(input: A2ASignInput): A2ASignedRequest {
  const peerId = input.peerId
  if (!PEER_ID_PATTERN.test(peerId)) {
    throw new A2AAuthError('malformed_header', 'malformed A2A peer header')
  }
  const timestamp = input.timestamp ?? Date.now()
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new A2AAuthError('malformed_header', 'malformed A2A timestamp')
  }
  const timestampText = String(timestamp)
  if (!TIMESTAMP_PATTERN.test(timestampText)) {
    throw new A2AAuthError('malformed_header', 'malformed A2A timestamp')
  }
  const nonce = input.nonce ?? randomBytes(16).toString('hex')
  if (!NONCE_PATTERN.test(nonce)) {
    throw new A2AAuthError('malformed_header', 'malformed A2A nonce')
  }

  const canonical = canonicalString(peerId, timestampText, nonce, bytesOf(input.body))
  return {
    headers: {
      [A2A_AUTH_HEADERS.peer]: peerId,
      [A2A_AUTH_HEADERS.timestamp]: timestampText,
      [A2A_AUTH_HEADERS.nonce]: nonce,
      [A2A_AUTH_HEADERS.signature]: signCanonical(input.secret, canonical),
    },
    canonical,
  }
}

/**
 * Verifies one HTTP A2A request. Checks, in order: peer header shape,
 * timestamp shape and ±60 s skew, nonce shape, signature hex shape, shared
 * secret presence, constant-time HMAC comparison, and nonce replay. Any
 * failure throws `A2AAuthError`.
 */
export function verifyA2ARequest(input: A2AVerifyInput): A2AVerifiedRequest {
  const peerId = peerIdOf(input.headers)

  const timestampText = requiredHeader(input.headers, A2A_AUTH_HEADERS.timestamp)
  if (!TIMESTAMP_PATTERN.test(timestampText)) {
    throw new A2AAuthError('malformed_header', 'malformed A2A timestamp')
  }
  const timestamp = Number(timestampText)
  if (!Number.isSafeInteger(timestamp)) {
    throw new A2AAuthError('malformed_header', 'malformed A2A timestamp')
  }

  const nonce = requiredHeader(input.headers, A2A_AUTH_HEADERS.nonce)
  if (!NONCE_PATTERN.test(nonce)) {
    throw new A2AAuthError('malformed_header', 'malformed A2A nonce')
  }

  const signature = requiredHeader(input.headers, A2A_AUTH_HEADERS.signature)
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new A2AAuthError('malformed_header', 'malformed A2A signature')
  }

  const now = input.now ?? Date.now()
  const skew = input.maxSkewMs ?? A2A_AUTH_MAX_SKEW_MS
  if (!Number.isFinite(now) || !Number.isFinite(skew) || skew < 0) {
    throw new A2AAuthError('timestamp_skew', 'A2A request timestamp outside the allowed window')
  }
  if (Math.abs(now - timestamp) > skew) {
    throw new A2AAuthError('timestamp_skew', 'A2A request timestamp outside the allowed window')
  }

  const secret = input.resolveSecret
    ? input.resolveSecret(peerId)
    : input.secret
  if (secret === undefined) {
    if (input.resolveSecret) {
      throw new A2AAuthError('unknown_peer', 'unknown A2A peer')
    }
    throw new A2AAuthError('invalid_secret', 'A2A peer secret is not configured')
  }

  const canonical = canonicalString(peerId, timestampText, nonce, bytesOf(input.body))
  const expected = Buffer.from(signCanonical(secret, canonical), 'hex')
  const supplied = Buffer.from(signature, 'hex')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new A2AAuthError('invalid_signature', 'invalid A2A request signature')
  }

  const replayCache = input.replayCache ?? defaultReplayCache
  if (!replayCache.checkAndAdd(peerId, nonce, timestamp, now)) {
    throw new A2AAuthError('replay', 'A2A request nonce was already used')
  }

  return { peerId }
}
