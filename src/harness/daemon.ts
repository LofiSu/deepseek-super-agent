/** Process-local daemon: wakes the watchdog on a timer. Workers stay in-process in v0. */
export class Daemon {
  private timer?: NodeJS.Timeout

  constructor(
    private readonly watchdog: { tick: () => void; intervalMs: number },
    private readonly log: (line: string) => void,
  ) {}

  start(): void {
    this.log('[daemon] start')
    this.watchdog.tick()
    this.timer = setInterval(() => this.watchdog.tick(), this.watchdog.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.log('[daemon] stop')
  }
}
