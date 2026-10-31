import type { MachineRegistry } from './machines.ts'

/** Process-local daemon: wakes the watchdog on a timer. Holds no session state (T38/T40). */
export class Daemon {
  private timer?: NodeJS.Timeout

  constructor(
    private readonly watchdog: { tick: () => void; intervalMs: number },
    private readonly log: (line: string) => void,
    private readonly machines?: MachineRegistry,
  ) {}

  start(): void {
    this.log('[daemon] start')
    this.watchdog.tick()
    this.timer = setInterval(() => this.tick(), this.watchdog.intervalMs)
  }

  /** One scheduling pulse: skip Env hands when all machines offline; never touch Session. */
  tick(): void {
    if (this.machines) {
      const online = this.machines.list().filter(m => m.status === 'online')
      if (this.machines.list().length > 0 && online.length === 0) {
        this.log('[daemon] all hands offline; brain continues from Store only')
      }
      for (const m of this.machines.list()) {
        if (m.status === 'online') continue
        this.log(`[daemon] hands offline machine=${m.id}; Store resume when heartbeat returns`)
      }
    }
    this.watchdog.tick()
  }

  /** Call after a machine heartbeat to resume hands without loading Session into the daemon. */
  onMachineResume(machineId: string): void {
    this.log(`[daemon] hands resume machine=${machineId}; state remains in Store`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.log('[daemon] stop')
  }
}
