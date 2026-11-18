import type { MachineRegistry } from './machines.ts'

/** Process-local daemon: wakes the watchdog on a timer. Holds no session state (T38/T40). */
export class Daemon {
  private timer?: NodeJS.Timeout

  constructor(
    private readonly watchdog: { tick: () => void; intervalMs: number },
    private readonly log: (line: string) => void,
    private readonly machines?: MachineRegistry,
    private readonly onResume?: (machineId: string) => void,
    /** Owner-defined routines, due-checked on the same pulse as the watchdog. */
    private readonly routines?: { tick: (now: number) => unknown },
    /**
     * Built-in idle self-wake, due-checked on the same pulse. It never owns a
     * timer or a second loop; `tick` decides one round and may hand a trigger
     * to the normal ingress path.
     */
    private readonly proactive?: { tick: (now: number) => unknown },
  ) {}

  /**
   * Long-lived processes pass `routines: true`. One-shot CLI commands must
   * leave it false: firing a routine from a short-lived `approve`/`retry`
   * process starts owner-level work whose channel loop is not running.
   */
  start(options: { routines?: boolean; proactive?: boolean } = {}): void {
    this.log('[daemon] start')
    this.safeTick(() => this.watchdog.tick())
    if (options.routines !== false) this.safeTick(() => this.routines?.tick(Date.now()))
    if (options.proactive !== false) this.safeTick(() => this.proactive?.tick(Date.now()))
    this.timer = setInterval(() => this.tick(), this.watchdog.intervalMs)
  }

  /** One scheduling pulse: skip Env hands when all machines offline; never touch Session. */
  tick(now = Date.now()): void {
    if (this.machines) {
      this.machines.markStaleOffline(now)
      const machineList = this.machines.list()
      const online = machineList.filter(m => m.status === 'online')
      if (machineList.length > 0 && online.length === 0) {
        this.log('[daemon] all hands offline; brain continues from Store only')
      }
      for (const m of machineList) {
        if (m.status === 'online') continue
        this.log(`[daemon] hands offline machine=${m.id}; Store resume when heartbeat returns`)
      }
    }
    this.safeTick(() => this.watchdog.tick())
    this.safeTick(() => this.routines?.tick(now))
    this.safeTick(() => this.proactive?.tick(now))
  }

  /**
   * An exception in an interval callback terminates the process. A store
   * hiccup or a corrupt job must be logged and retried on the next pulse, not
   * turn a serving daemon into a crash loop.
   */
  private safeTick(run: () => unknown): void {
    try {
      run()
    } catch (error) {
      this.log(`[daemon] tick failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Call after a machine heartbeat to resume hands without loading Session into the daemon. */
  onMachineResume(machineId: string): void {
    this.log(`[daemon] hands resume machine=${machineId}; state remains in Store`)
    this.onResume?.(machineId)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.log('[daemon] stop')
  }
}
