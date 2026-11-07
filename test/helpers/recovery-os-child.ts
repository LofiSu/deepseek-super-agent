/**
 * Standalone child entry for OS-level restart recovery tests. Invoked only from
 * `test/restart-recovery-os-fault.test.ts` — not part of the product CLI.
 */
import fs from 'node:fs'
import { Runtime } from '../../src/runtime.ts'
import type { Ticket } from '../../src/shared/types.ts'
import { ScriptedModel } from '../scripted-model.ts'

const home = process.argv[2]
if (!home) {
  console.error('recovery-os-child: missing DS_AGENT_HOME argument')
  process.exit(2)
}

const marker = `${home}/.recovery-child-ready`

function runningTicket(id: string): Ticket {
  const at = new Date().toISOString()
  return {
    id,
    title: 'child recovery probe',
    brief: 'validate recovery across a real process boundary',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'probe',
      actor: { source: 'cli', id: 'test' },
      basis: 'addressed',
    },
    threadKeys: ['cli:recovery-probe'],
    channels: [{ source: 'cli', thread: 'recovery-probe' }],
    inputs: [],
    assignments: [{
      id: `asg_${id}_1`,
      state: 'running',
      speculative: false,
      workerSessionId: `worker_${id}`,
      startedAt: at,
    }],
    speculative: false,
    originTriggerId: `trg_${id}`,
    createdAt: at,
  }
}

const runtime = Runtime.create({
  home,
  model: new ScriptedModel(() => ({ text: 'recovery-child-done' }), 'ScriptedRecoveryModel'),
  jobDelayMs: 0,
  watchdogIntervalMs: 600_000,
  stuckMs: 600_000,
})

try {
  const mode = process.env.DS_AGENT_RECOVERY_CHILD_MODE
  if (mode === 'seed') {
    runtime.store.putDoc('ticket', 'ticket_os_fault', runningTicket('ticket_os_fault'))
  }
  runtime.start({ assessPending: false })
  const boundary = runtime.recoveryBoundary()
  fs.writeFileSync(marker, JSON.stringify({
    outcome: boundary?.outcome ?? 'missing',
    tickets: boundary?.tickets ?? [],
    model: boundary?.model,
  }))
  console.log(`recovery-os-child ready outcome=${boundary?.outcome ?? 'missing'}`)
} catch (error) {
  console.error(String(error))
  process.exit(1)
}

process.on('SIGTERM', () => {
  void runtime.finish().then(() => process.exit(0), () => process.exit(1))
})
