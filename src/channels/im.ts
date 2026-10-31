import type { Trigger } from '../shared/types.ts'

export function imTrigger(input: {
  id?: string
  thread: string
  text: string
  actor?: string
  addressed?: boolean
  at?: string
}): Trigger {
  return {
    id: input.id ?? `trg_im_${Date.now().toString(36)}`,
    source: 'im',
    threads: [{ source: 'im', id: input.thread }],
    actor: { source: 'im', id: input.actor ?? 'alex' },
    human: true,
    addressed: input.addressed === false ? undefined : 'mention',
    at: input.at ?? new Date().toISOString(),
    text: input.text,
    channel: { source: 'im', thread: input.thread },
    meta: {},
  }
}
