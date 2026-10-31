import type { Trigger } from '../shared/types.ts'

export function githubTrigger(input: {
  id?: string
  pr: number
  text: string
  actor?: string
  speculate?: boolean
  at?: string
}): Trigger {
  const thread = `pr/${input.pr}`
  return {
    id: input.id ?? `trg_gh_${input.pr}_${Date.now().toString(36)}`,
    source: 'github',
    threads: [{ source: 'github', id: thread }],
    actor: { source: 'github', id: input.actor ?? 'ci-bot' },
    human: false,
    at: input.at ?? new Date().toISOString(),
    text: input.text,
    channel: { source: 'github', thread },
    meta: { pr: input.pr, ...(input.speculate ? { speculate: true } : {}) },
  }
}
