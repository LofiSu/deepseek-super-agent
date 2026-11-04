import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  A2A_AUTH_HEADERS,
  A2AAuthError,
  createA2AReplayCache,
  signA2ARequest,
  verifyA2ARequest,
  type A2AAuthErrorCode,
  type A2ASignInput,
  type A2AVerifyInput,
} from '../src/channels/a2a-auth.ts'

const PEER = 'peer-a'
const SECRET = 'a2a-test-secret-never-log-me'
const OTHER_SECRET = 'a2a-other-secret-never-log-me'
const NOW = 1_700_000_000_000
const NONCE = '0123456789abcdef0123456789abcdef'
const BODY = JSON.stringify({ from: PEER, to: 'worker-b', body: { text: 'hello' } })

function sign(overrides: Partial<A2ASignInput> = {}) {
  return signA2ARequest({
    peerId: PEER,
    secret: SECRET,
    body: BODY,
    timestamp: NOW,
    nonce: NONCE,
    ...overrides,
  })
}

function verify(overrides: Partial<A2AVerifyInput> = {}) {
  return verifyA2ARequest({
    headers: sign().headers,
    body: BODY,
    secret: SECRET,
    now: NOW,
    replayCache: createA2AReplayCache(),
    ...overrides,
  })
}

function authErrorOf(run: () => unknown): A2AAuthError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(A2AAuthError)
    return error as A2AAuthError
  }
  throw new Error('expected A2AAuthError')
}

function expectAuthError(run: () => unknown, code: A2AAuthErrorCode): void {
  expect(authErrorOf(run).code).toBe(code)
}

describe('A2A request signing', () => {
  it('round-trips a valid signature over the canonical v1 string', () => {
    const signed = sign()
    const bodyHash = createHash('sha256').update(BODY, 'utf8').digest('hex')

    expect(signed.canonical).toBe(`v1\n${PEER}\n${NOW}\n${NONCE}\n${bodyHash}`)
    expect(signed.headers).toEqual({
      [A2A_AUTH_HEADERS.peer]: PEER,
      [A2A_AUTH_HEADERS.timestamp]: String(NOW),
      [A2A_AUTH_HEADERS.nonce]: NONCE,
      [A2A_AUTH_HEADERS.signature]: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(verify().peerId).toBe(PEER)
  })

  it('accepts an uppercase nonce but signs and verifies the same bytes', () => {
    const nonce = 'ABCDEF0123456789ABCDEF0123456789'
    const headers = sign({ nonce }).headers
    expect(headers[A2A_AUTH_HEADERS.nonce]).toBe(nonce)
    expect(verify({ headers, replayCache: createA2AReplayCache() }).peerId).toBe(PEER)
  })

  it('generates a fresh 32-hex-char nonce when one is omitted', () => {
    const first = sign({ nonce: undefined })
    const second = sign({ nonce: undefined })
    expect(first.headers[A2A_AUTH_HEADERS.nonce]).toMatch(/^[0-9a-f]{32}$/)
    expect(second.headers[A2A_AUTH_HEADERS.nonce]).toMatch(/^[0-9a-f]{32}$/)
    expect(first.headers[A2A_AUTH_HEADERS.nonce]).not.toBe(second.headers[A2A_AUTH_HEADERS.nonce])
  })
})

describe('A2A request verification', () => {
  it('rejects a tampered body, peer, timestamp, or nonce', () => {
    const headers = sign().headers
    const cases: Array<[Partial<A2AVerifyInput>, A2AAuthErrorCode]> = [
      [{ body: `${BODY} ` }, 'invalid_signature'],
      [{ headers: { ...headers, [A2A_AUTH_HEADERS.peer]: 'peer-b' } }, 'invalid_signature'],
      [{ headers: { ...headers, [A2A_AUTH_HEADERS.timestamp]: String(NOW - 1) } }, 'invalid_signature'],
      [{ headers: { ...headers, [A2A_AUTH_HEADERS.nonce]: 'f'.repeat(32) } }, 'invalid_signature'],
    ]
    for (const [overrides, code] of cases) {
      expectAuthError(() => verify(overrides), code)
    }
  })

  it('rejects a wrong secret, malformed hex, wrong length, and missing headers', () => {
    expectAuthError(() => verify({ secret: OTHER_SECRET }), 'invalid_signature')

    const headers = sign().headers
    expectAuthError(
      () => verify({ headers: { ...headers, [A2A_AUTH_HEADERS.signature]: 'zz'.repeat(32) } }),
      'malformed_header',
    )
    expectAuthError(
      () => verify({ headers: { ...headers, [A2A_AUTH_HEADERS.signature]: 'ab' } }),
      'malformed_header',
    )
    expectAuthError(
      () => verify({ headers: { ...headers, [A2A_AUTH_HEADERS.signature]: 'A'.repeat(64) } }),
      'malformed_header',
    )

    for (const name of Object.values(A2A_AUTH_HEADERS)) {
      const missing: Record<string, string> = { ...headers }
      delete missing[name]
      expectAuthError(() => verify({ headers: missing }), 'missing_header')
    }
  })

  it('rejects duplicate auth headers', () => {
    const headers = sign().headers
    const duplicated = {
      ...headers,
      [A2A_AUTH_HEADERS.peer]: [PEER, PEER],
    }
    expectAuthError(
      () => verify({ headers: duplicated, replayCache: createA2AReplayCache() }),
      'malformed_header',
    )
  })

  it('rejects timestamps outside ±60 s and accepts the exact boundaries', () => {
    for (const delta of [-60_001, 60_001]) {
      const headers = sign({ timestamp: NOW + delta }).headers
      expectAuthError(
        () => verify({ headers, now: NOW, replayCache: createA2AReplayCache() }),
        'timestamp_skew',
      )
    }
    for (const delta of [-60_000, 60_000]) {
      const headers = sign({ timestamp: NOW + delta }).headers
      expect(verify({ headers, now: NOW, replayCache: createA2AReplayCache() }).peerId).toBe(PEER)
    }
  })

  it('rejects a replayed nonce within the window and accepts it after expiry', () => {
    const cache = createA2AReplayCache()
    const headers = sign({ timestamp: NOW }).headers
    const input: A2AVerifyInput = {
      headers,
      body: BODY,
      secret: SECRET,
      now: NOW,
      replayCache: cache,
    }

    expect(verifyA2ARequest(input).peerId).toBe(PEER)
    expectAuthError(() => verifyA2ARequest(input), 'replay')

    // The first entry expires at NOW + 60 s. A later request reusing the same
    // nonce (with a fresh timestamp/signature) is accepted after pruning.
    const later = NOW + 120_000
    const laterHeaders = sign({ timestamp: later }).headers
    expect(verifyA2ARequest({
      headers: laterHeaders,
      body: BODY,
      secret: SECRET,
      now: later,
      replayCache: cache,
    }).peerId).toBe(PEER)
  })

  it('does not consume the nonce when the signature fails', () => {
    const cache = createA2AReplayCache()
    const headers = sign().headers
    const tampered = {
      ...headers,
      [A2A_AUTH_HEADERS.signature]: '0'.repeat(64),
    }

    expectAuthError(
      () => verify({ headers: tampered, replayCache: cache }),
      'invalid_signature',
    )
    // Signature verification precedes the replay check, so the first failed
    // attempt must not burn the nonce for the corrected retry.
    expect(verify({ headers, replayCache: cache }).peerId).toBe(PEER)
  })

  it('keeps the replay cache bounded and prunes expired entries', () => {
    const cache = createA2AReplayCache({ maxEntries: 2 })
    const nonceA = 'a'.repeat(32)
    const nonceB = 'b'.repeat(32)
    const nonceC = 'c'.repeat(32)

    expect(cache.checkAndAdd(PEER, nonceA, NOW, NOW)).toBe(true)
    expect(cache.checkAndAdd(PEER, nonceB, NOW, NOW)).toBe(true)
    expect(cache.checkAndAdd(PEER, nonceC, NOW, NOW)).toBe(true)
    expect(cache.size).toBe(2)

    // A was the oldest insertion and was evicted; C is still remembered.
    expect(cache.checkAndAdd(PEER, nonceA, NOW, NOW)).toBe(true)
    expect(cache.checkAndAdd(PEER, nonceC, NOW, NOW)).toBe(false)
    expect(cache.size).toBe(2)

    cache.prune(NOW + 60_001)
    expect(cache.size).toBe(0)
  })

  it('scopes replay entries by peer', () => {
    const cache = createA2AReplayCache()
    const headers = sign().headers
    expect(verify({ headers, replayCache: cache }).peerId).toBe(PEER)

    // A different peer may use the same nonce value.
    const otherHeaders = sign({ peerId: 'peer-b', nonce: NONCE }).headers
    expect(verify({
      headers: otherHeaders,
      secret: SECRET,
      replayCache: cache,
    }).peerId).toBe('peer-b')
  })

  it('rejects an unknown peer through resolveSecret', () => {
    const headers = sign().headers
    const seen: string[] = []
    expectAuthError(
      () => verify({
        headers,
        secret: undefined,
        resolveSecret: peerId => {
          seen.push(peerId)
          return undefined
        },
      }),
      'unknown_peer',
    )
    expect(seen).toEqual([PEER])

    const known = sign({ nonce: 'b'.repeat(32) }).headers
    const result = verify({
      headers: known,
      secret: undefined,
      resolveSecret: peerId => (peerId === PEER ? SECRET : undefined),
    })
    expect(result.peerId).toBe(PEER)
  })

  it('rejects an empty secret without echoing it', () => {
    expectAuthError(
      () => verify({ secret: '' }),
      'invalid_secret',
    )
    expectAuthError(
      () => sign({ secret: '' }),
      'invalid_secret',
    )
  })

  it('never puts the secret or signature in an error message', () => {
    const signed = sign()
    const signature = signed.headers[A2A_AUTH_HEADERS.signature]!
    const failures = [
      () => verify({ secret: OTHER_SECRET }),
      () => verify({ body: `${BODY} ` }),
      () => verify({ headers: { ...signed.headers, [A2A_AUTH_HEADERS.peer]: 'peer-b' } }),
      () => verify({ headers: { ...signed.headers, [A2A_AUTH_HEADERS.timestamp]: String(NOW - 120_000) } }),
      () => verify({ headers: { ...signed.headers, [A2A_AUTH_HEADERS.signature]: '0'.repeat(64) } }),
    ]

    for (const fail of failures) {
      const error = authErrorOf(fail)
      const rendered = `${error.name}: ${error.message}`
      expect(rendered).not.toContain(SECRET)
      expect(rendered).not.toContain(OTHER_SECRET)
      expect(rendered).not.toContain(signature)
    }
  })
})
