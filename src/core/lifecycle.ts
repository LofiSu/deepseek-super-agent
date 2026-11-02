/** A read-model event from the Engine/Runtime to a panel or CLI. */
export interface LifecycleEvent {
  kind: string
  payload: unknown
}

/**
 * Lifecycle event bus (T49). A panel subscribes by kind and reads state without
 * holding a Session; `snapshot` is the bounded catch-up view.
 */
export class LifecycleBus {
  readonly history: LifecycleEvent[] = []
  private readonly listeners = new Map<string, Set<(event: LifecycleEvent) => void>>()

  subscribe(kind: string, listener: (event: LifecycleEvent) => void): () => void {
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

  publish(event: LifecycleEvent): LifecycleEvent {
    this.history.push(event)
    for (const listener of this.listeners.get(event.kind) ?? []) listener(event)
    return event
  }

  /** Read model for a panel/CLI without giving it a Session. */
  snapshot(limit = 50): LifecycleEvent[] {
    return this.history.slice(-Math.max(0, Math.floor(limit)))
  }
}
