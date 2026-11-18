import crypto from 'node:crypto'

/**
 * GitHub App / webhook X-Hub-Signature-256 verifier for a future operator-mounted
 * HTTPS endpoint. Not started by `serve`; polling is the deployed ingress.
 */
export function verifyGithubWebhookSignature256(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret?.trim()) return false
  if (!signatureHeader?.startsWith('sha256=')) return false
  const expected = signatureHeader.slice('sha256='.length)
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
}
