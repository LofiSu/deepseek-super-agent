import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveTrustedEvolutionRoot } from './io.ts'

const LOCK_NAME = 'final-test.claim.lock'
const CONSUMED_NAME = 'final-test.claim.consumed'

export interface ClaimLockRecord {
  claimToken: string
  pid: number
  candidateId: string
  openedAt: string
}

export interface ConsumedClaimRecord {
  claimToken: string
  state: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'
  closedAt: string
}

export function claimLockPath(home: string): string {
  return path.join(resolveTrustedEvolutionRoot(home), LOCK_NAME)
}

export function claimConsumedPath(home: string): string {
  return path.join(resolveTrustedEvolutionRoot(home), CONSUMED_NAME)
}

/** OS-exclusive create; survives until released or marked consumed. */
export function acquireFinalTestClaimLock(home: string, candidateId: string): ClaimLockRecord {
  const consumed = claimConsumedPath(home)
  if (fs.existsSync(consumed)) {
    throw new Error('final test claim already consumed')
  }
  const lockPath = claimLockPath(home)
  const record: ClaimLockRecord = {
    claimToken: randomUUID(),
    pid: process.pid,
    candidateId,
    openedAt: new Date().toISOString(),
  }
  const body = JSON.stringify(record)
  try {
    const fd = fs.openSync(lockPath, 'wx')
    try {
      fs.writeSync(fd, body, 0, 'utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'EEXIST') {
      throw new Error('final test claim lock held by another process')
    }
    throw error
  }
  return record
}

export function releaseFinalTestClaimLock(home: string, claimToken: string): void {
  const lockPath = claimLockPath(home)
  if (!fs.existsSync(lockPath)) return
  const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as ClaimLockRecord
  if (onDisk.claimToken !== claimToken) {
    throw new Error('final test claim lock token mismatch')
  }
  fs.unlinkSync(lockPath)
}

export function markFinalTestClaimConsumed(
  home: string,
  claimToken: string,
  state: ConsumedClaimRecord['state'],
): void {
  const consumedPath = claimConsumedPath(home)
  const payload: ConsumedClaimRecord = {
    claimToken,
    state,
    closedAt: new Date().toISOString(),
  }
  const fd = fs.openSync(consumedPath, 'wx')
  try {
    fs.writeSync(fd, JSON.stringify(payload), 0, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  try {
    releaseFinalTestClaimLock(home, claimToken)
  } catch {
    // lock may already be gone
  }
}
