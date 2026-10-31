import type { Trigger } from '../shared/types.ts'

export function cliTrigger(input: { id?: string; text: string; actor?: string; at?: string }): Trigger {
  return {
    id: input.id ?? `trg_cli_${Date.now().toString(36)}`,
    source: 'cli',
    threads: [{ source: 'cli', id: 'local' }],
    actor: { source: 'cli', id: input.actor ?? 'you' },
    human: true,
    addressed: 'direct',
    at: input.at ?? new Date().toISOString(),
    text: input.text,
    channel: { source: 'cli', thread: 'local' },
    meta: {},
  }
}
