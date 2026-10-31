import type { ProductShellEvent } from './types.ts'

export class ProductShellBus {
  readonly history: ProductShellEvent[] = []
  private readonly listeners = new Map<string, Set<(event: ProductShellEvent) => void>>()

  subscribe(kind: string, listener: (event: ProductShellEvent) => void): () => void {
    let listeners = this.listeners.get(kind)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(kind, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(kind)
    }
  }

  publish(event: ProductShellEvent): ProductShellEvent {
    this.history.push(event)
    for (const listener of this.listeners.get(event.kind) ?? []) listener(event)
    return event
  }
}
