/** Phase-2 placeholders from PLAN T09 / T46–T50. Not wired into Runtime. */

export interface RouterShard {
  id: string
  filter?: string
}

export interface WorkerMeshNode {
  id: string
  capacity: number
}

export interface LongTermMemoryQuery {
  ticketId?: string
  text: string
  limit?: number
}

export interface LongTermMemoryEntry {
  id: string
  ticketId: string
  spillId: string
  text: string
  createdAt: string
}

export interface ProductShellEvent {
  kind: string
  payload: unknown
}

export interface A2AEnvelope {
  from: string
  to: string
  body: unknown
}
