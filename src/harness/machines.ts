export type MachineStatus = 'online' | 'offline'

export interface MachineRecord {
  id: string
  capabilities: string[]
  status: MachineStatus
  lastHeartbeat: string
  lastSeenOnline?: string
}

/**
 * Brain/hands split (PLAN T40): brain stays on Harness/Model; hands are Env on a machine.
 * Daemon holds no session state — only machine liveness from heartbeats.
 */
export class MachineRegistry {
  private readonly machines = new Map<string, MachineRecord>()

  constructor(private readonly staleMs: number = Number(process.env.DS_AGENT_MACHINE_STALE_MS) > 0
    ? Number(process.env.DS_AGENT_MACHINE_STALE_MS)
    : Infinity) {}

  markStaleOffline(now = Date.now()): MachineRecord[] {
    const stale: MachineRecord[] = []
    for (const row of this.machines.values()) {
      if (row.status === 'online' && now - Date.parse(row.lastHeartbeat) > this.staleMs) {
        row.status = 'offline'
        stale.push({ ...row, capabilities: [...row.capabilities] })
      }
    }
    return stale
  }

  register(machineId: string, capabilities: string[] = []): MachineRecord {
    const now = new Date().toISOString()
    const row: MachineRecord = {
      id: machineId,
      capabilities: [...capabilities],
      status: 'online',
      lastHeartbeat: now,
      lastSeenOnline: now,
    }
    this.machines.set(machineId, row)
    return { ...row, capabilities: [...row.capabilities] }
  }

  heartbeat(machineId: string): MachineRecord & { resumed: boolean } {
    const existing = this.machines.get(machineId)
    const now = new Date().toISOString()
    if (!existing) return { ...this.register(machineId), resumed: false }
    const wasOffline = existing.status === 'offline'
    existing.status = 'online'
    existing.lastHeartbeat = now
    existing.lastSeenOnline = now
    return { ...existing, capabilities: [...existing.capabilities], resumed: wasOffline }
  }

  markOffline(machineId: string): MachineRecord | undefined {
    const row = this.machines.get(machineId)
    if (!row) return undefined
    row.status = 'offline'
    return { ...row, capabilities: [...row.capabilities] }
  }

  pickHands(ticketId: string, need: string[] = []): MachineRecord | undefined {
    void ticketId
    const online = [...this.machines.values()].filter(m => m.status === 'online')
    if (need.length === 0) return online[0] ? { ...online[0], capabilities: [...online[0].capabilities] } : undefined
    const match = online.find(m => need.every(n => m.capabilities.includes(n)))
    return match ? { ...match, capabilities: [...match.capabilities] } : undefined
  }

  list(): MachineRecord[] {
    return [...this.machines.values()].map(m => ({ ...m, capabilities: [...m.capabilities] }))
  }

  get(machineId: string): MachineRecord | undefined {
    const row = this.machines.get(machineId)
    return row ? { ...row, capabilities: [...row.capabilities] } : undefined
  }
}
