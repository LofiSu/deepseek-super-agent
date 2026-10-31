import type { MachineRegistry } from './machines.ts'

/** Process-local daemon: wakes the watchdog on a timer. Holds no session state (T38/T40). */
export class Daemon {
  private timer?: NodeJS.Timeout

  constructor(
    private readonly watchdog: { tick: () => void; intervalMs: number },
    private readonly log: (line: string) => void,
    private readonly machines?: MachineRegistry,
    private readonly onResume?: (machineId: string) => void,
  ) {}

  start(): void {
    this.log('[daemon] start')
    this.watchdog.tick()
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
    this.watchdog.tick()
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
