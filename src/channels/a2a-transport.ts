import type { A2ADelivery, A2AEnvelope, A2ARouter } from './a2a.ts'

/**
 * Cross-process A2A transport contract (T50).
 *
 * A transport only moves an `A2AEnvelope` between processes. It does not own
 * validation, persistence, admission, or identity:
 *
 * - Inbound envelopes are untrusted bytes. Transports must pass them to
 *   `A2ARouter.send` (or an ingress built on it), which validates, applies the
 *   64 KiB UTF-8 byte cap, persists, and produces the non-human `a2a` Trigger.
 *   `send` normalizes identity/timestamps (fresh `id`/`at`) and drops unknown
 *   fields. A transport must never construct a `Trigger` itself.
 * - `A2AEnvelope` carries no human identity. Peer authentication is external to
 *   this interface, and the in-repo A2A ingress always produces a non-human
 *   Trigger. Attributing a human identity through this contract is NOT
 *   supported, and an adapter must not do it by bypassing ingress through
 *   `runtime.ingest` either. The fail-closed default is non-human.
 * - `send` must not rewrite `from`/`to`/`body`; it may only move the envelope.
 *
 * Network I/O and peer authentication (mTLS, signed envelopes, bearer tokens,
 * etc.) are deliberately external. `LocalA2ATransport` is the in-repo reference
 * implementation and test double; it uses the in-process router and therefore
 * makes no authentication claim.
 */
export interface A2ATransport {
  /** Deliver an envelope. Remote implementations may resolve asynchronously. */
  send(envelope: A2AEnvelope): Promise<A2ADelivery> | A2ADelivery

  /**
   * Optional inbound subscription. Listeners receive untrusted envelopes and
   * must pass them through `A2ARouter.send`; they are not Triggers.
   */
  receive?(listener: (envelope: A2AEnvelope) => void): () => void
}

/**
 * In-process reference transport. It defers every contract responsibility to
 * `A2ARouter.send`, so it is useful as a test double and as the template for a
 * network adapter's local delivery half.
 *
 * It is not an authentication boundary: do not expose it to another process.
 */
export class LocalA2ATransport implements A2ATransport {
  constructor(private readonly router: Pick<A2ARouter, 'send'>) {}

  send(envelope: A2AEnvelope): A2ADelivery {
    return this.router.send(envelope)
  }
}
