import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-publish-outcome-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function runCli(home: string, args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, DS_AGENT_HOME: home, NODE_NO_WARNINGS: '1' },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('publish-outcome owner diagnosis', () => {
  it('shows a consumed publication admission and the evidence still missing', () => {
    const home = makeHome()
    const store = new Store(home)
    try {
      store.putDoc('ticket', 'ticket-owner-diagnosis', {
        id: 'ticket-owner-diagnosis',
        title: 'Publisher outcome fixture',
        ended: { at: '2026-11-21T00:00:00.000Z', outcome: 'stopped', by: 'human' },
        collab: { approvals: [{
          id: 'approval-consumed',
          publish: { repo: 'mutable/changed', head: 'b'.repeat(40), branch: 'peanut/changed', base: 'main', title: 'Mutable current ticket title' },
        }] },
      })
      expect(store.admitPublishApprovalOnce({
        ticketId: 'ticket-owner-diagnosis',
        approvalId: 'approval-consumed',
        binding: {
          repo: 'owner/repo',
          head: 'a'.repeat(40),
          branch: 'peanut/diagnosis',
          base: 'main',
          title: 'Immutable approved title',
        },
      })).toBe(true)
      store.markPublishAttemptStarted('ticket-owner-diagnosis', 'approval-consumed')
    } finally {
      store.close()
    }

    const result = runCli(home, ['publish-outcome', 'ticket-owner-diagnosis', '--json'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('approval-consumed')
    expect(result.stdout).toContain('attempt_started')
    expect(result.stdout).toContain('Immutable approved title')
    expect(result.stdout).toContain('remoteInspectionPerformed')
    expect(result.stdout).toContain('owner/repo')
    expect(result.stdout).not.toContain('mutable/changed')
    expect(result.stdout).not.toContain('Mutable current ticket title')
    const reopened = new Store(home)
    try {
      expect(reopened.listPublishAdmissions('ticket-owner-diagnosis')[0]?.observationState).toBe('attempt_started')
      expect(reopened.getDoc<{ collab?: { approvals?: unknown[] } }>('ticket', 'ticket-owner-diagnosis')?.collab?.approvals)
        .toHaveLength(1)
    } finally {
      reopened.close()
    }
  })

  it('discloses a historical admission without synthesizing its binding or outcome', () => {
    const home = makeHome()
    const store = new Store(home)
    try {
      store.putDoc('ticket', 'ticket-legacy-outcome', {
        id: 'ticket-legacy-outcome',
        title: 'Legacy fixture',
        ended: { at: '2026-11-20T00:00:00.000Z', outcome: 'stopped', by: 'human' },
      })
      expect(store.admitPublishApprovalOnce({
        ticketId: 'ticket-legacy-outcome',
        approvalId: 'approval-legacy',
        binding: {
          repo: 'owner/repo', head: 'a'.repeat(40), branch: 'peanut/old', base: 'main', title: 'old approval',
        },
      })).toBe(true)
    } finally {
      store.close()
    }
    const legacyDb = new DatabaseSync(path.join(home, 'ds-agent.db'))
    legacyDb.prepare(`UPDATE publish_approval_admissions
                      SET binding_json = NULL, observation_state = 'legacy_unrecorded'
                      WHERE ticket_id = ? AND approval_id = ?`)
      .run('ticket-legacy-outcome', 'approval-legacy')
    legacyDb.close()
    const result = runCli(home, ['publish-outcome', 'ticket-legacy-outcome', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const diagnosis = JSON.parse(result.stdout) as { admissions: Array<Record<string, unknown>> }
    expect(diagnosis.admissions).toEqual([expect.objectContaining({
      approvalId: 'approval-legacy',
      observationState: 'legacy_unrecorded',
    })])
    expect(diagnosis.admissions[0]).not.toHaveProperty('binding')
    expect(diagnosis.admissions[0]).not.toHaveProperty('result')
  })
})
