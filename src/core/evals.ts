import { nextBatch } from '../ingress/batch.ts'
import type { Decision, Strength, Thread, Trigger } from '../shared/types.ts'
import type { Host } from './host.ts'
import type { Tickets } from './tickets.ts'

export class Evals {
  constructor(private readonly host: Host, private readonly tickets: Tickets) {}

  evaluateDue(): Decision[] {
    const decisions: Decision[] = []
    const due = this.host.repo.listDocs<Thread>('thread').filter(thread => thread.pending.length > 0)
    for (const thread of due) {
      const ids = nextBatch(thread.pending)
      thread.pending = []
      const triggers = ids
        .map(id => this.host.repo.getDoc<Trigger>('trigger', id))
        .filter((trigger): trigger is Trigger => trigger != null)
      if (!triggers.length) {
        this.host.repo.putDoc('thread', thread.key, thread)
        continue
      }
      const primary = triggers.find(trigger => trigger.addressed) ?? triggers[0]!
      const strength = strengthOf(primary)
      const evalId = this.host.repo.nextId('eval')
      this.host.log(`[engine] Evals.batch thread=${thread.key} size=${ids.length} triggerIds=${ids.join(',')}`)
      this.host.repo.addEvent('eval.started', { evalId, threadKey: thread.key, triggerIds: ids, strength })
      const decision = this.tickets.create({ thread, triggers, primary, strength, evalId })
      this.host.repo.putDoc('thread', thread.key, thread)
      decisions.push(decision)
    }
    return decisions
  }
}

function strengthOf(trigger: Trigger): Strength {
  const value = trigger.meta.strength
  if (value === 'explicit' || value === 'inferred' || value === 'maybe') return value
  if (trigger.addressed) return 'explicit'
  return 'inferred'
}
