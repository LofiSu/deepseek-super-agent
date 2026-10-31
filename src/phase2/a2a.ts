import type { A2AEnvelope } from './types.ts'

export class A2ARouter {
  readonly history: A2AEnvelope[] = []
  private readonly recipients = new Map<string, Set<(envelope: A2AEnvelope) => void>>()

  register(recipient: string, handler: (envelope: A2AEnvelope) => void): () => void {
    let handlers = this.recipients.get(recipient)
    if (!handlers) {
      handlers = new Set()
      this.recipients.set(recipient, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) this.recipients.delete(recipient)
    }
  }

  route(envelope: A2AEnvelope): A2AEnvelope {
    this.history.push(envelope)
    for (const handler of this.recipients.get(envelope.to) ?? []) handler(envelope)
    return envelope
  }
}
