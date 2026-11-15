import dns from 'node:dns/promises'
import net from 'node:net'
import { UserError } from '../shared/errors.ts'

export interface TrustedFetchOptions {
  allowHosts: readonly string[]
  fetchImpl?: typeof fetch
  maxBytes?: number
}

function ipv4ToNum(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let n = 0
  for (const p of parts) {
    const o = Number(p)
    if (!Number.isInteger(o) || o < 0 || o > 255) return undefined
    n = (n << 8) + o
  }
  return n >>> 0
}

function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '0.0.0.0') return true
  if (lower === '127.0.0.1' || lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower)
  if (mapped) return isPrivateIp(mapped[1]!)

  if (net.isIPv4(ip)) {
    const n = ipv4ToNum(ip)
    if (n === undefined) return false
    if ((n & 0xff000000) === 0x7f000000) return true // 127.0.0.0/8
    if ((n & 0xff000000) === 0x0a000000) return true // 10.0.0.0/8
    if ((n & 0xfff00000) === 0xac100000) return true // 172.16.0.0/12
    if ((n & 0xffff0000) === 0xc0a80000) return true // 192.168.0.0/16
    if ((n & 0xffff0000) === 0xa9fe0000) return true // 169.254.0.0/16 link-local
    return false
  }

  if (lower.startsWith('fe80:')) return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique-local fc00::/7
  return false
}

function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const h = host.toLowerCase()
  return allowHosts.some(a => a.toLowerCase() === h)
}

async function assertResolvesPublic(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new UserError(`trusted-fetch: refused private IP ${hostname}`)
    return
  }
  const results = await dns.lookup(hostname, { all: true, verbatim: true })
  for (const r of results) {
    if (isPrivateIp(r.address)) {
      throw new UserError(`trusted-fetch: ${hostname} resolves to blocked address ${r.address}`)
    }
  }
}

/**
 * Host-side HTTPS fetch with SSRF protections. Not exposed to sandboxed bash.
 */
export async function trustedFetch(
  rawUrl: string,
  options: TrustedFetchOptions,
): Promise<{ url: string; body: string; fetchedAt: string }> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UserError('trusted-fetch: invalid URL')
  }
  if (url.protocol === 'file:') throw new UserError('trusted-fetch: file:// refused')
  if (url.protocol !== 'https:') throw new UserError('trusted-fetch: only https:// allowed')
  if (!hostAllowed(url.hostname, options.allowHosts)) {
    throw new UserError(`trusted-fetch: host ${url.hostname} not in allowlist`)
  }
  await assertResolvesPublic(url.hostname)

  const fetchImpl = options.fetchImpl ?? fetch
  const res = await fetchImpl(url.toString(), {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status >= 300 && res.status < 400) {
    throw new UserError('trusted-fetch: redirects refused')
  }
  if (!res.ok) throw new UserError(`trusted-fetch: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const max = options.maxBytes ?? 512_000
  const body = buf.slice(0, max).toString('utf8')
  return { url: url.toString(), body, fetchedAt: new Date().toISOString() }
}

