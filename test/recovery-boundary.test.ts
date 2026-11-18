import { describe, expect, it } from 'vitest'
import type { Recovery } from '../src/core/assignments.ts'
import {
  recordLaunchFailed,
  recordLaunchScheduled,
  recoveryBoundaryFromOutcomes,
} from '../src/core/recovery-boundary.ts'

describe('recovery boundary record', () => {
  it('maps engine outcomes and launch lifecycle transitions', () => {
    const recovered: Recovery[] = [{
      ticketId: 'ticket_a',
      interruptedAssignmentIds: ['asg_old'],
      replacementAssignmentId: 'asg_new',
    }, {
      ticketId: 'ticket_b',
      interruptedAssignmentIds: [],
      replacementAssignmentId: 'asg_pending',
      relaunchOnly: true,
    }]
    let record = recoveryBoundaryFromOutcomes('Stub', '2026-01-01T00:00:00.000Z', 'completed', recovered)
    expect(record.schemaVersion).toBe(1)
    expect(record.tickets).toEqual([
      {
        ticketId: 'ticket_a',
        transition: 'recovered',
        replacementAssignmentId: 'asg_new',
        interruptedAssignmentIds: ['asg_old'],
      },
      {
        ticketId: 'ticket_b',
        transition: 'relaunch_only',
        replacementAssignmentId: 'asg_pending',
        interruptedAssignmentIds: [],
      },
    ])
    record = recordLaunchScheduled(record, 'ticket_a')
    expect(record.tickets.find(t => t.ticketId === 'ticket_a')?.transition).toBe('relaunch_scheduled')
    record = recordLaunchFailed(record, 'ticket_a')
    expect(record.tickets.find(t => t.ticketId === 'ticket_a')?.transition).toBe('launch_failed')
  })

  it('records mock deferral without mutating tickets', () => {
    const record = recoveryBoundaryFromOutcomes(
      'MockModel',
      '2026-01-01T00:00:00.000Z',
      'deferred',
      [],
      { deferReason: 'mock-model' },
    )
    expect(record.outcome).toBe('deferred')
    expect(record.deferReason).toBe('mock-model')
    expect(record.tickets).toEqual([])
  })
})
