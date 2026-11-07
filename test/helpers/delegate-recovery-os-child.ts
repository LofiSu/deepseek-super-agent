/**
 * OS-process child: seeds a running ticket, runs delegate_agent mid-flight, or
 * completes recovery on restart. Not part of the product CLI.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bindRolePorts } from '../../src/core/role-ports.ts'
import { LocalEnv } from '../../src/env/local-env.ts'
import { ScriptedModel } from '../scripted-model.ts'
import { ToolRegistry } from '../../src/harness/tools.ts'
import { Runtime } from '../../src/runtime.ts'
import type { Ticket } from '../../src/shared/types.ts'
import { UNKNOWN_OUTCOME_PREFIX } from '../../src/core/external-effects.ts'
import { RECOVERY_BOUNDARY_DOC_ID, type RecoveryBoundaryRecord } from '../../src/core/recovery-boundary.ts'

const home = process.argv[2]
if (!home) {
  console.error('delegate-recovery-os-child: missing home')
  process.exit(2)
}

const marker = path.join(home, '.delegate-os-ready')
const mode = process.env.DS_AGENT_RECOVERY_CHILD_MODE ?? 'seed'
const task = process.env.DS_AGENT_DELEGATE_TASK ?? 'delegate-task'

function runningTicket(): Ticket {
  const at = new Date().toISOString()
  return {
    id: 'ticket_delegate_os',
    title: 'delegate os fault',
    brief: 'probe delegate across process boundary',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'probe',
      actor: { source: 'cli', id: 'test' },
      basis: 'addressed',
    },
    threadKeys: ['cli:delegate'],
    channels: [{ source: 'cli', thread: 'delegate' }],
    inputs: [],
    assignments: [{
      id: 'asg_delegate_1',
      state: 'running',
      speculative: false,
      workerSessionId: 'worker_ticket_delegate_os',
      startedAt: at,
    }],
    speculative: false,
    originTriggerId: 'trg_delegate',
    createdAt: at,
  }
}

async function main(): Promise<void> {
  const runtime = Runtime.create({
    home,
    model: new ScriptedModel(() => ({ text: 'delegate-os-child' }), 'ScriptedRecoveryModel'),
    jobDelayMs: 0,
    watchdogIntervalMs: 600_000,
    stuckMs: 600_000,
    env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1' },
  })

  const localAgents = runtime.localAgents
  if (!localAgents) {
    throw new Error('delegate-recovery-os-child: local-agents.json missing in home')
  }

  const tools = new ToolRegistry({
    store: runtime.store,
    ports: bindRolePorts(runtime.engine),
    env: new LocalEnv(path.join(home, 'workspaces')),
    metrics: runtime.metrics,
    redact: text => text,
    log: () => {},
    scheduleJob: () => {},
    routerTurn: async () => {},
    localAgents,
  })

  if (mode === 'seed') {
    // Start once with no tickets so recoveryAttempted is set; then seed a
    // running ticket without auto-recover mutating it before delegate_agent.
    runtime.start({ assessPending: false })
    runtime.store.putDoc('ticket', 'ticket_delegate_os', runningTicket())
    void tools.invoke(
      { id: 'd1', name: 'delegate_agent', args: { agent: 'ipc-hold', task } },
      { sessionId: 'worker_ticket_delegate_os', role: 'worker', ticketId: 'ticket_delegate_os' },
    )
    for (let i = 0; i < 300 && localAgents.activeCount === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    fs.writeFileSync(marker, `${JSON.stringify({
      phase: 'delegating',
      delegateActive: localAgents.activeCount,
    })}\n`)
  } else if (mode === 'restart') {
    runtime.start({ assessPending: false })
    const boundary = runtime.store.getDoc<RecoveryBoundaryRecord>('recovery', RECOVERY_BOUNDARY_DOC_ID)
    const ticket = runtime.store.getDoc<Ticket>('ticket', 'ticket_delegate_os')
    fs.writeFileSync(marker, `${JSON.stringify({
      phase: 'post-recovery',
      recoveryOutcome: boundary?.outcome,
      assignmentCount: ticket?.assignments.length,
      lastAssignmentState: ticket?.assignments.at(-1)?.state,
      recoveredInputs: ticket?.inputs.filter(i => i.text?.startsWith('RECOVERED:')).length ?? 0,
      unknownApprovals: ticket?.collab?.approvals?.filter(a =>
        a.status === 'pending' && a.action.startsWith(UNKNOWN_OUTCOME_PREFIX)).length ?? 0,
    })}\n`)
  }

  process.on('SIGTERM', () => {
    localAgents.killAll()
    void runtime.finish().then(() => process.exit(0), () => process.exit(1))
  })
}

main().catch(error => {
  console.error(String(error))
  process.exit(1)
})
