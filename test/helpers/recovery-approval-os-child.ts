/**
 * Child entry for approval-hold recovery across a real process boundary.
 */
import fs from 'node:fs'
import { Store } from '../../src/store/sqlite.ts'
import type { Ticket } from '../../src/shared/types.ts'
import { Runtime } from '../../src/runtime.ts'
import { ScriptedModel } from '../scripted-model.ts'

const home = process.argv[2]
if (!home) {
  console.error('recovery-approval-os-child: missing home')
  process.exit(2)
}

const marker = `${home}/.recovery-approval-child-ready`

function fabricate(id: string, withApproval: boolean): Ticket {
  const at = new Date().toISOString()
  const base: Ticket = {
    id,
    title: 'probe',
    brief: 'probe',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'probe',
      actor: { source: 'cli', id: 'test' },
      basis: 'addressed',
    },
    threadKeys: ['cli:probe'],
    channels: [{ source: 'cli', thread: 'probe' }],
    inputs: [],
    assignments: [{
      id: `asg_${id}`,
      state: 'running',
      speculative: false,
      workerSessionId: `worker_${id}`,
      startedAt: at,
    }],
    speculative: false,
    originTriggerId: `trg_${id}`,
    createdAt: at,
  }
  if (!withApproval) return base
  return {
    ...base,
    collab: {
      guidance: [],
      resumes: [],
      approvals: [{
        id: 'appr_os',
        at,
        action: 'publish the release',
        requestedBy: 'worker',
        status: 'pending',
      }],
    },
  }
}

const store = new Store(home)

store.putDoc('ticket', 'ticket_approval_held', fabricate('ticket_approval_held', true))
store.putDoc('ticket', 'ticket_normal', fabricate('ticket_normal', false))

const runtime = Runtime.create({
  home,
  model: new ScriptedModel(() => ({ text: 'approval-recovery-child' }), 'ScriptedRecoveryModel'),
  jobDelayMs: 0,
  watchdogIntervalMs: 600_000,
  stuckMs: 600_000,
  env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1' },
})

try {
  runtime.start({ assessPending: false })
  const held = store.getDoc<Ticket>('ticket', 'ticket_approval_held')!
  const normal = store.getDoc<Ticket>('ticket', 'ticket_normal')!
  fs.writeFileSync(marker, JSON.stringify({
    heldAssignments: held.assignments.length,
    normalAssignments: normal.assignments.length,
    heldRecoveredInputs: held.inputs.filter(i => i.text?.startsWith('RECOVERED:')).length,
    normalRecoveredInputs: normal.inputs.filter(i => i.text?.startsWith('RECOVERED:')).length,
    approvalPending: held.collab?.approvals?.[0]?.status,
  }))
} catch (error) {
  console.error(String(error))
  process.exit(1)
}

process.on('SIGTERM', () => {
  void runtime.finish().then(() => process.exit(0), () => process.exit(1))
})
