import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveTrustedEvolutionRoot } from './io.ts'

const LOCK_NAME = 'search-run.lock'

export interface SearchRunLockRecord {
  lockToken: string
  pid: number
  openedAt: string
}

export function searchRunLockPath(home: string): string {
  return path.join(resolveTrustedEvolutionRoot(home), LOCK_NAME)
}

/** Exclusive search-run lock: one evolution search at a time per home. */
export function acquireSearchRunLock(home: string): SearchRunLockRecord {
  const lockPath = searchRunLockPath(home)
  const record: SearchRunLockRecord = {
    lockToken: randomUUID(),
    pid: process.pid,
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
      throw new Error('search run lock held by another process')
    }
    throw error
  }
  return record
}

export function releaseSearchRunLock(home: string, lockToken: string): void {
  const lockPath = searchRunLockPath(home)
  if (!fs.existsSync(lockPath)) return
  const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as SearchRunLockRecord
  if (onDisk.lockToken !== lockToken) {
    throw new Error('search run lock token mismatch')
  }
  fs.unlinkSync(lockPath)
}
