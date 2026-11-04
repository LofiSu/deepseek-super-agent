import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { A2ARouter, type A2ADelivery, type A2AEnvelope } from '../src/channels/a2a.ts'
import {
  A2AHttpTransport,
  A2A_HTTP_MAX_RESPONSE_BYTES,
  createA2AHttpHandler,
  type A2AHttpHandlerOptions,
} from '../src/channels/a2a-http.ts'
import {
  A2A_AUTH_HEADERS,
  createA2AReplayCache,
  signA2ARequest,
  type A2ASecret,
} from '../src/channels/a2a-auth.ts'

const PEER = 'peer-a'
const SECRET = 'a2a-http-test-secret-never-log-me-0123456789'
const WRONG_SECRET = 'a2a-http-wrong-secret-never-log-me-0123456789'
const NOW = 1_700_000_000_000
const BODY = JSON.stringify({ from: PEER, to: 'worker', body: { text: 'hello' } })

const servers: Server[] = []
let nonceCounter = 0

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

function nextNonce(): string {
  nonceCounter += 1
  return nonceCounter.toString(16).padStart(32, '0')
}

interface SignOverrides {
  peerId?: string
  secret?: A2ASecret
  timestamp?: number
  nonce?: string
}

function signedHeaders(body: string, overrides: SignOverrides = {}): Record<string, string> {
  return signA2ARequest({
    peerId: overrides.peerId ?? PEER,
    secret: overrides.secret ?? SECRET,
    body,
    timestamp: overrides.timestamp ?? NOW,
    nonce: overrides.nonce ?? nextNonce(),
  }).headers
}

interface PostOptions {
  body?: string
  headers?: Record<string, string>
  /** `null` omits the content-type header entirely. */
  contentType?: string | null
}

async function post(url: string, options: PostOptions = {}): Promise<Response> {
  const body = options.body ?? BODY
  const headers: Record<string, string> = { ...(options.headers ?? signedHeaders(body)) }
  if (options.contentType !== null) {
    headers['content-type'] = options.contentType ?? 'application/json'
  }
  return fetch(url, { method: 'POST', headers, body })
}

async function listen(options: A2AHttpHandlerOptions): Promise<string> {
  const server = createServer(createA2AHttpHandler(options))
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('A2A test server did not bind')
  }
  return `http://127.0.0.1:${address.port}/a2a`
}

interface Harness {
  url: string
  router: A2ARouter
  received: A2AEnvelope[]
}

async function harness(overrides: Partial<A2AHttpHandlerOptions> = {}): Promise<Harness> {
  const router = new A2ARouter()
  const received: A2AEnvelope[] = []
  router.register('worker', envelope => received.push(envelope))
  const url = await listen({
    router,
    resolveSecret: peerId => (peerId === PEER ? SECRET : undefined),
    now: () => NOW,
    replayCache: createA2AReplayCache(),
    ...overrides,
  })
  return { url, router, received }
}

/** Transport clients sign with the real clock, so the handler must use it too. */
function realClock(): () => number {
  return () => Date.now()
}

describe('A2A HTTP handler', () => {
  it('delivers a valid signed request using the authenticated peer id', async () => {
    const { url, received } = await harness()

    const res = await post(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const delivery = await res.json() as A2ADelivery
    expect(delivery).toMatchObject({ status: 'delivered', delivered: 1, persisted: false })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ from: PEER, to: 'worker', body: { text: 'hello' } })
    expect(received[0]).toEqual(delivery.envelope)

    // `from` is optional on the wire; the authenticated id fills it in.
    const omitted = JSON.stringify({ to: 'worker', body: 'no from field' })
    const second = await post(url, { body: omitted, headers: signedHeaders(omitted) })
    expect(second.status).toBe(200)
    expect(received[1]).toMatchObject({ from: PEER, to: 'worker', body: 'no from field' })
  })

  it('drops unknown wire fields and never lets the caller mint id/at/human', async () => {
    const { url, received } = await harness()
    const body = JSON.stringify({
      from: PEER,
      to: 'worker',
      body: 'clean',
      id: 'a2a_forged',
      at: '1970-01-01T00:00:00.000Z',
      human: true,
    })

    const res = await post(url, { body, headers: signedHeaders(body) })
    expect(res.status).toBe(200)
    expect(received).toHaveLength(1)
    const envelope = received[0] as A2AEnvelope & { human?: boolean }
    expect(Object.keys(envelope).sort()).toEqual(['at', 'body', 'from', 'id', 'to'])
    expect(envelope.id).not.toBe('a2a_forged')
    expect(envelope.at).not.toBe('1970-01-01T00:00:00.000Z')
    expect('human' in envelope).toBe(false)
  })

  it('rejects a forged from claiming another identity and the router never sees it', async () => {
    const { url, received, router } = await harness()
    const forged = JSON.stringify({ from: 'human', to: 'worker', body: { text: 'do it' } })

    const res = await post(url, { body: forged, headers: signedHeaders(forged) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
    expect(received).toHaveLength(0)
    expect(router.list()).toHaveLength(0)
    expect(JSON.stringify(router.history)).not.toContain('human')
  })

  it('returns 401 for a bad signature and does not call the router', async () => {
    const { url, received } = await harness()
    const headers = signedHeaders(BODY)
    headers[A2A_AUTH_HEADERS.signature] = '0'.repeat(64)

    const res = await post(url, { headers })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(received).toHaveLength(0)
  })

  it('returns 401 for a replayed nonce', async () => {
    const { url, received } = await harness()
    const headers = signedHeaders(BODY)

    const first = await post(url, { headers })
    expect(first.status).toBe(200)
    const replay = await post(url, { headers })
    expect(replay.status).toBe(401)
    expect(received).toHaveLength(1)
  })

  it('rejects cross-node replay when handlers share a replay cache', async () => {
    const cache = createA2AReplayCache()
    const first = await harness({ replayCache: cache })
    const second = await harness({ replayCache: cache })
    const headers = signedHeaders(BODY)

    expect((await post(first.url, { headers })).status).toBe(200)
    expect((await post(second.url, { headers })).status).toBe(401)
    expect(second.received).toHaveLength(0)
  })

  it('returns 401 for clock skew, unknown peers, and missing headers', async () => {
    const { url, received } = await harness()

    const skewed = await post(url, {
      headers: signedHeaders(BODY, { timestamp: NOW - 120_000 }),
    })
    expect(skewed.status).toBe(401)

    const unknown = await post(url, {
      headers: signedHeaders(BODY, { peerId: 'peer-z' }),
    })
    expect(unknown.status).toBe(401)

    const headers = signedHeaders(BODY)
    delete headers[A2A_AUTH_HEADERS.signature]
    const missing = await post(url, { headers })
    expect(missing.status).toBe(401)

    expect(received).toHaveLength(0)
  })

  it('rejects an unknown peer before buffering an oversize body', async () => {
    const { url, received } = await harness()
    const oversized = JSON.stringify({
      from: PEER,
      to: 'worker',
      body: 'x'.repeat(64 * 1024),
    })

    const res = await post(url, {
      body: oversized,
      headers: signedHeaders(oversized, { peerId: 'peer-z' }),
    })

    // The peer/secret check runs before the declared-length check and before
    // any body bytes are read, so this is 401 rather than 400.
    expect(res.status).toBe(401)
    expect(received).toHaveLength(0)
  })

  it('returns 400 for oversize, invalid JSON, missing body, and wrong content type', async () => {
    const { url, received } = await harness()

    const oversized = JSON.stringify({
      from: PEER,
      to: 'worker',
      body: 'x'.repeat(64 * 1024),
    })
    expect(oversized.length).toBeGreaterThan(64 * 1024)
    const tooLarge = await post(url, { body: oversized, headers: signedHeaders(oversized) })
    expect(tooLarge.status).toBe(400)

    const invalid = '{not-json'
    const invalidJson = await post(url, { body: invalid, headers: signedHeaders(invalid) })
    expect(invalidJson.status).toBe(400)

    const missingBody = JSON.stringify({ from: PEER, to: 'worker' })
    const missing = await post(url, {
      body: missingBody,
      headers: signedHeaders(missingBody),
    })
    expect(missing.status).toBe(400)

    const wrongType = await post(url, { contentType: 'text/plain' })
    expect(wrongType.status).toBe(400)

    expect(received).toHaveLength(0)
  })

  it('enforces the streaming 64 KiB cap when content-length is absent', async () => {
    const { url, received } = await harness()
    const oversized = JSON.stringify({
      from: PEER,
      to: 'worker',
      body: 'x'.repeat(64 * 1024),
    })
    const headers = {
      'content-type': 'application/json',
      ...signedHeaders(oversized),
    }

    let hadContentLength = false
    const result = await new Promise<{ status: number; hadContentLength: boolean }>(
      (resolve, reject) => {
        const req = httpRequest(url, { method: 'POST', headers }, res => {
          res.resume()
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, hadContentLength })
          })
          res.on('error', reject)
        })
        hadContentLength = req.getHeader('content-length') !== undefined
        req.on('error', reject)
        // No content-length header: Node streams this with chunked encoding,
        // so `declaredBodyTooLarge` cannot short-circuit and `readRawBody` must
        // enforce the cap itself.
        req.write(oversized)
        req.end()
      },
    )

    expect(result.hadContentLength).toBe(false)
    expect(result.status).toBe(400)
    expect(received).toHaveLength(0)
  })

  it('destroys a stalled request after the configured timeout', async () => {
    const { url, received } = await harness({ requestTimeoutMs: 50 })
    const port = Number(new URL(url).port)
    const socket = connect({ host: '127.0.0.1', port })
    const closed = new Promise<void>(resolve => {
      socket.once('close', () => resolve())
      socket.once('error', () => resolve())
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })

    const headers = signedHeaders(BODY)
    const head = [
      'POST /a2a HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Content-Length: 100',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ].join('\r\n')

    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      socket.write(`${head}\r\n\r\n{`)
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(
            () => reject(new Error('stalled request was not destroyed')),
            2_000,
          )
        }),
      ])
    } finally {
      if (guard !== undefined) clearTimeout(guard)
      socket.destroy()
    }
    expect(received).toHaveLength(0)
  })

  it('destroys a slow-drip body at the absolute deadline, not by inactivity', async () => {
    const { url, received } = await harness({ requestTimeoutMs: 100 })
    const port = Number(new URL(url).port)
    const socket = connect({ host: '127.0.0.1', port })
    const closed = new Promise<void>(resolve => {
      socket.once('close', () => resolve())
      socket.once('error', () => resolve())
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })

    const headers = signedHeaders(BODY)
    const head = [
      'POST /a2a HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Content-Length: 1000',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ].join('\r\n')

    let drip: ReturnType<typeof setInterval> | undefined
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      socket.write(`${head}\r\n\r\n`)
      // One byte every 25 ms keeps the inactivity timer fed but cannot extend
      // the absolute deadline.
      drip = setInterval(() => {
        if (!socket.destroyed) socket.write('x')
      }, 25)
      const started = Date.now()
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(
            () => reject(new Error('slow-drip request was not destroyed')),
            2_000,
          )
        }),
      ])
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      if (drip !== undefined) clearInterval(drip)
      if (guard !== undefined) clearTimeout(guard)
      socket.destroy()
    }
    expect(received).toHaveLength(0)
  })

  it('bounds a hanging resolveSecret with the absolute deadline', async () => {
    const router = new A2ARouter()
    const received: A2AEnvelope[] = []
    router.register('worker', envelope => received.push(envelope))
    const url = await listen({
      router,
      resolveSecret: () => new Promise(resolve => setTimeout(() => resolve(SECRET), 100)),
      now: () => NOW,
      replayCache: createA2AReplayCache(),
      requestTimeoutMs: 50,
    })

    const started = Date.now()
    await expect(post(url)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)

    // Wait past the resolver's own resolution. The request must already have
    // failed at the absolute deadline, so verification/delivery never resumes.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(received).toHaveLength(0)
  })

  it('maps an unroutable envelope to 404 and preserves it through the transport', async () => {
    const { url } = await harness({ now: realClock() })
    const body = JSON.stringify({ from: PEER, to: 'nobody', body: 'work' })

    const res = await post(url, { body, headers: signedHeaders(body, { timestamp: Date.now() }) })
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const delivery = await res.json() as A2ADelivery
    expect(delivery).toMatchObject({ status: 'unroutable', delivered: 0 })

    const transport = new A2AHttpTransport({ url, peerId: PEER, secret: SECRET })
    const viaTransport = await transport.send({ from: PEER, to: 'nobody', body: 'work' })
    expect(viaTransport.status).toBe('unroutable')
  })

  it('maps a router handler exception to a non-leaking 502', async () => {
    const router = new A2ARouter()
    router.register('worker', () => { throw new Error('sensitive internal failure') })
    const url = await listen({
      router,
      resolveSecret: () => SECRET,
      now: () => NOW,
      replayCache: createA2AReplayCache(),
    })
    const body = JSON.stringify({ from: PEER, to: 'worker', body: 'boom' })

    const res = await post(url, { body, headers: signedHeaders(body) })
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain('sensitive internal failure')
    expect(JSON.parse(text)).toEqual({ error: 'delivery failed' })
  })
})

describe('A2AHttpTransport', () => {
  it('sends through the local handler and returns the delivery', async () => {
    const { url, received } = await harness({ now: realClock() })
    const transport = new A2AHttpTransport({ url, peerId: PEER, secret: SECRET })

    const delivery = await transport.send({
      from: PEER,
      to: 'worker',
      body: { text: 'via transport' },
    })

    expect(delivery).toMatchObject({ status: 'delivered', delivered: 1, persisted: false })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      from: PEER,
      to: 'worker',
      body: { text: 'via transport' },
    })
    expect(received[0]).toEqual(delivery.envelope)
  })

  it('returns a failed delivery for rejected auth and does not call the router', async () => {
    const { url, received } = await harness({ now: realClock() })
    const transport = new A2AHttpTransport({ url, peerId: PEER, secret: WRONG_SECRET })

    const delivery = await transport.send({ from: PEER, to: 'worker', body: 'nope' })

    expect(delivery.status).toBe('failed')
    expect(delivery.delivered).toBe(0)
    expect(delivery.persisted).toBe(false)
    expect(delivery.error).toMatch(/status 401/)
    expect(received).toHaveLength(0)
    expect(JSON.stringify(delivery)).not.toContain(WRONG_SECRET)
    expect(JSON.stringify(delivery)).not.toContain(SECRET)
  })

  it('rejects a from mismatch locally without making a request', async () => {
    let calls = 0
    const fetchImpl: typeof globalThis.fetch = () => {
      calls += 1
      return Promise.resolve(new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    const transport = new A2AHttpTransport({
      url: 'http://127.0.0.1:9/a2a',
      peerId: PEER,
      secret: SECRET,
      fetch: fetchImpl,
    })

    const delivery = await transport.send({ from: 'human', to: 'worker', body: 'nope' })

    expect(delivery.status).toBe('failed')
    expect(delivery.delivered).toBe(0)
    expect(delivery.error).toMatch(/does not match the authenticated peer/)
    expect(calls).toBe(0)
  })

  it('returns a failed delivery when the request times out', async () => {
    const neverFetch: typeof globalThis.fetch = () => new Promise<never>(() => {})
    const transport = new A2AHttpTransport({
      url: 'http://127.0.0.1:9/a2a',
      peerId: PEER,
      secret: SECRET,
      fetch: neverFetch,
      timeoutMs: 25,
    })

    const started = Date.now()
    const delivery = await transport.send({ from: PEER, to: 'worker', body: 'slow' })

    expect(delivery.status).toBe('failed')
    expect(delivery.delivered).toBe(0)
    expect(delivery.error).toMatch(/timed out/)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(JSON.stringify(delivery)).not.toContain(SECRET)
  })

  it('rejects non-https, non-loopback endpoints', () => {
    expect(() => new A2AHttpTransport({
      url: 'http://example.com/a2a',
      peerId: PEER,
      secret: SECRET,
    })).toThrow(/https or a loopback/)

    expect(() => new A2AHttpTransport({
      url: 'ftp://127.0.0.1/a2a',
      peerId: PEER,
      secret: SECRET,
    })).toThrow(/https or a loopback/)

    expect(() => new A2AHttpTransport({
      url: 'not a url',
      peerId: PEER,
      secret: SECRET,
    })).toThrow(/absolute URL/)

    expect(() => new A2AHttpTransport({
      url: 'https://example.com/a2a',
      peerId: PEER,
      secret: SECRET,
    })).not.toThrow()

    expect(() => new A2AHttpTransport({
      url: 'http://localhost:9/a2a',
      peerId: PEER,
      secret: SECRET,
    })).not.toThrow()
  })

  it('times out while reading a stalled response body', async () => {
    const stalled = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          releaseLock: () => {},
        }),
      },
    } as unknown as Response
    const fetchImpl: typeof globalThis.fetch = () => Promise.resolve(stalled)
    const transport = new A2AHttpTransport({
      url: 'http://127.0.0.1:9/a2a',
      peerId: PEER,
      secret: SECRET,
      fetch: fetchImpl,
      timeoutMs: 50,
    })

    const started = Date.now()
    const delivery = await transport.send({ from: PEER, to: 'worker', body: 'stall' })

    expect(delivery.status).toBe('failed')
    expect(delivery.error).toMatch(/timed out/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('times out when a real server stalls the response body', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{')
      // Deliberately never end the response.
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) {
      throw new Error('stalled server did not bind')
    }
    const transport = new A2AHttpTransport({
      url: `http://127.0.0.1:${address.port}/a2a`,
      peerId: PEER,
      secret: SECRET,
      timeoutMs: 50,
    })

    const started = Date.now()
    const delivery = await transport.send({ from: PEER, to: 'worker', body: 'x' })

    expect(delivery.status).toBe('failed')
    expect(delivery.error).toMatch(/timed out/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('rejects a response larger than 128 KiB', async () => {
    const oversized = JSON.stringify({
      envelope: { from: PEER, to: 'worker', body: 'x' },
      status: 'delivered',
      delivered: 1,
      persisted: false,
      padding: 'x'.repeat(A2A_HTTP_MAX_RESPONSE_BYTES),
    })
    const fetchImpl: typeof globalThis.fetch = () => Promise.resolve(new Response(oversized, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const transport = new A2AHttpTransport({
      url: 'http://127.0.0.1:9/a2a',
      peerId: PEER,
      secret: SECRET,
      fetch: fetchImpl,
    })

    const delivery = await transport.send({ from: PEER, to: 'worker', body: 'x' })

    expect(delivery.status).toBe('failed')
    expect(delivery.error).toMatch(/too large/)
  })

  it('requires a JSON response and refuses redirects', async () => {
    const plain: typeof globalThis.fetch = () => Promise.resolve(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))
    const plainTransport = new A2AHttpTransport({
      url: 'http://127.0.0.1:9/a2a',
      peerId: PEER,
      secret: SECRET,
      fetch: plain,
    })
    const plainDelivery = await plainTransport.send({ from: PEER, to: 'worker', body: 'x' })
    expect(plainDelivery.status).toBe('failed')
    expect(plainDelivery.error).toMatch(/not JSON/)

    let init: RequestInit | undefined
    const responseBody = JSON.stringify({
      envelope: { from: PEER, to: 'worker', body: 'x' },
      status: 'delivered',
      delivered: 1,
      persisted: false,
    })
    const json: typeof globalThis.fetch = (_input, options) => {
      init = options
      return Promise.resolve(new Response(responseBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    const transport = new A2AHttpTransport({
      url: 'http://127.0.0.1:9/a2a',
      peerId: PEER,
      secret: SECRET,
      fetch: json,
    })
    const delivery = await transport.send({ from: PEER, to: 'worker', body: 'x' })
    expect(delivery.status).toBe('delivered')
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not trust a delivery shape without a matching status and envelope', async () => {
    const sendWith = (payload: unknown, status: number) => {
      const fetchImpl: typeof globalThis.fetch = () => Promise.resolve(new Response(
        JSON.stringify(payload),
        { status, headers: { 'content-type': 'application/json' } },
      ))
      return new A2AHttpTransport({
        url: 'http://127.0.0.1:9/a2a',
        peerId: PEER,
        secret: SECRET,
        fetch: fetchImpl,
      }).send({ from: PEER, to: 'worker', body: 'x' })
    }
    const base = {
      envelope: { from: PEER, to: 'worker', body: 'x' },
      status: 'delivered',
      delivered: 1,
      persisted: false,
    }

    // Delivery-shaped JSON on a 401 is untrusted.
    expect((await sendWith(base, 401)).status).toBe('failed')
    // Delivered status on a 404 is inconsistent.
    expect((await sendWith(base, 404)).status).toBe('failed')
    // A rogue sender in the returned envelope is rejected.
    expect((await sendWith({
      ...base,
      envelope: { from: 'human', to: 'worker', body: 'x' },
    }, 200)).status).toBe('failed')
    // Fractional/negative counts and envelopes without a body are rejected.
    expect((await sendWith({ ...base, delivered: 1.5 }, 200)).status).toBe('failed')
    expect((await sendWith({ ...base, delivered: -1 }, 200)).status).toBe('failed')
    expect((await sendWith({
      ...base,
      envelope: { from: PEER, to: 'worker' },
    }, 200)).status).toBe('failed')
  })
})

describe('A2A HTTP secret hygiene', () => {
  it('never captures the secret or signature in logs or error responses', async () => {
    const logged: unknown[] = []
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args) }),
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args) }),
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args) }),
    ]

    try {
      const { url } = await harness()
      const validHeaders = signedHeaders(BODY)
      const signature = validHeaders[A2A_AUTH_HEADERS.signature]!
      const responses: string[] = []

      const badSignature = { ...validHeaders, [A2A_AUTH_HEADERS.signature]: '0'.repeat(64) }
      responses.push(await (await post(url, { headers: badSignature })).text())

      responses.push(await (await post(url, {
        headers: signedHeaders(BODY, { timestamp: NOW - 120_000 }),
      })).text())

      const malformed = '{bad'
      responses.push(await (await post(url, {
        body: malformed,
        headers: signedHeaders(malformed),
      })).text())

      responses.push(await (await post(url, {
        headers: signedHeaders(BODY, { peerId: 'peer-z' }),
      })).text())

      const captured = JSON.stringify(logged) + responses.join('\n')
      expect(captured).not.toContain(SECRET)
      expect(captured).not.toContain(signature)
      expect(logged).toEqual([])
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
