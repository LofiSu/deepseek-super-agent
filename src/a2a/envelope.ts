/** Local envelope only. Nothing in this module opens a socket. */

export const A2A_MESSAGE_TYPES = [
  'task.request',
  'task.update',
  'task.complete',
  'task.fail',
  'message.send',
  'message.ack',
] as const

export type A2AMessageType = typeof A2A_MESSAGE_TYPES[number]

export interface A2AParty {
  agentId: string
  instance?: string
}

export interface A2AEnvelope {
  version: '0'
  id: string
  type: A2AMessageType
  from: A2AParty
  to: A2AParty
  taskId?: string
  text?: string
  at: string
}

export function createA2AEnvelope(input: {
  type: A2AMessageType
  from: A2AParty
  to: A2AParty
  id?: string
  taskId?: string
  text?: string
  at?: string
}): A2AEnvelope {
  return {
    version: '0',
    id: input.id ?? `a2a_${Date.now().toString(36)}`,
    type: input.type,
    from: input.from,
    to: input.to,
    taskId: input.taskId,
    text: input.text,
    at: input.at ?? new Date().toISOString(),
  }
}

/** Empty list means the envelope is well-formed. Transport is out of scope. */
export function a2aProblems(message: A2AEnvelope): string[] {
  const problems: string[] = []
  if (message.version !== '0') problems.push('version')
  if (!message.id.trim()) problems.push('id')
  if (!A2A_MESSAGE_TYPES.includes(message.type)) problems.push('type')
  if (!message.from.agentId.trim()) problems.push('from')
  if (!message.to.agentId.trim()) problems.push('to')
  if (!message.at.trim()) problems.push('at')
  return problems
}
