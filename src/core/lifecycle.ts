/** A read-model event from the Engine/Runtime to a panel or CLI. */
export interface LifecycleEvent {
  kind: string
  payload: unknown
}

/**
 * Durable lifecycle-event sink. `append` records one event; `recent` returns
 * the newest `limit` events in publish order. The bus treats the sink as
 * best-effort: a failure never rejects `publish` and never removes the event
 * from the in-memory ring.
 */
export interface LifecyclePersistence {
  append(event: LifecycleEvent): void
  recent(limit: number): LifecycleEvent[]
}

export type LifecyclePersistenceOperation = 'append' | 'recent'

/**
 * Lifecycle event bus (T49). A panel subscribes by kind and reads state without
 * holding a Session; `snapshot` is the bounded catch-up view.
 *
 * The ring is always bounded and keep-newest. An optional persistence sink
 * mirrors events to durable storage so a restarted process can replay them;
 * call `hydrateFromSink` once at startup, before publishing new events.
 */
export class LifecycleBus {
  readonly history: LifecycleEvent[] = []
  /** The ring capacity; also the default persistent-log retention in Runtime. */
  readonly maxEvents: number
  private readonly listeners = new Map<string, Set<(event: LifecycleEvent) => void>>()
  private persistence: LifecyclePersistence | undefined
  private errorReporter: ((error: unknown, operation: LifecyclePersistenceOperation) => void) | undefined
  private persistenceErrorReported = false

  constructor(
    maxEvents = 1000,
    persistence?: LifecyclePersistence,
    onPersistenceError?: (error: unknown, operation: LifecyclePersistenceOperation) => void,
  ) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
      throw new Error('LifecycleBus maxEvents must be a positive integer')
    }
    this.maxEvents = maxEvents
    this.persistence = persistence
    this.errorReporter = onPersistenceError
  }

  /**
   * Attach (or replace) the durable sink. The first persistence failure after
   * attaching is reported through `onPersistenceError`; later failures are
   * suppressed so a broken sink cannot flood the log.
   */
  attachSink(
    persistence: LifecyclePersistence,
    onPersistenceError?: (error: unknown, operation: LifecyclePersistenceOperation) => void,
  ): void {
    this.persistence = persistence
    this.errorReporter = onPersistenceError
    this.persistenceErrorReported = false
  }

  /**
   * Startup-only: replace the ring with the supplied persisted events, keeping
   * at most `maxEvents` newest entries. A hydrated history is not written back
   * to the sink, so reopening cannot duplicate events.
   */
  hydrate(events: readonly LifecycleEvent[]): void {
    const bounded = events.slice(-this.maxEvents)
    this.history.splice(0, this.history.length, ...bounded)
  }

  /**
   * Startup-only: hydrate from the attached sink's newest events. Returns
   * `false` when the sink failed; the bus then starts with an empty ring.
   */
  hydrateFromSink(): boolean {
    if (!this.persistence) return true
    try {
      this.hydrate(this.persistence.recent(this.maxEvents))
      return true
    } catch (error) {
      this.reportPersistenceFailure(error, 'recent')
      return false
    }
  }

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
    if (this.history.length > this.maxEvents) {
      this.history.splice(0, this.history.length - this.maxEvents)
    }
    if (this.persistence) {
      try {
        this.persistence.append(event)
      } catch (error) {
        this.reportPersistenceFailure(error, 'append')
      }
    }
    for (const listener of this.listeners.get(event.kind) ?? []) listener(event)
    return event
  }

  /** Read model for a panel/CLI without giving it a Session. */
  snapshot(limit = 50): LifecycleEvent[] {
    return this.history.slice(-Math.max(0, Math.floor(limit)))
  }

  private reportPersistenceFailure(error: unknown, operation: LifecyclePersistenceOperation): void {
    if (this.persistenceErrorReported) return
    this.persistenceErrorReported = true
    this.errorReporter?.(error, operation)
  }
}
