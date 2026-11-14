import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireFinalTestClaimLock,
  claimConsumedPath,
  markFinalTestClaimConsumed,
  releaseFinalTestClaimLock,
} from '../src/evolution/final-test-claim-lock.ts'

describe('final test OS claim lock', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
  })

  it('second concurrent acquire fails (wx)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-lock-'))
    homes.push(home)
    fs.mkdirSync(path.join(home, 'evolution'), { recursive: true })
    const first = acquireFinalTestClaimLock(home, 'cand_a')
    expect(() => acquireFinalTestClaimLock(home, 'cand_a')).toThrow(/lock held/)
    releaseFinalTestClaimLock(home, first.claimToken)
    const second = acquireFinalTestClaimLock(home, 'cand_a')
    expect(second.claimToken).not.toBe(first.claimToken)
    markFinalTestClaimConsumed(home, second.claimToken, 'SUCCEEDED')
    expect(fs.existsSync(claimConsumedPath(home))).toBe(true)
    expect(() => acquireFinalTestClaimLock(home, 'cand_a')).toThrow(/consumed/)
  })
})
