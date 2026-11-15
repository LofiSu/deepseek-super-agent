import { describe, expect, it } from 'vitest'
import { UserError } from '../src/shared/errors.ts'
import {
  assertDevShellCommandAllowed,
  devShellCommandRejection,
  gitPushStatementTargetsProtected,
  protectedRefName,
  refspecTargetsProtectedBranch,
  splitShellStatements,
} from '../src/env/bash-policy.ts'

describe('bash policy — git push refspecs', () => {
  it('parses protected ref names', () => {
    expect(protectedRefName('main')).toBe(true)
    expect(protectedRefName('refs/heads/main')).toBe(true)
    expect(protectedRefName('origin/main')).toBe(true)
    expect(protectedRefName('feature/foo')).toBe(false)
    expect(protectedRefName('HEAD')).toBe(false)
  })

  it('detects refspec targets', () => {
    expect(refspecTargetsProtectedBranch('main')).toBe(true)
    expect(refspecTargetsProtectedBranch('HEAD:main')).toBe(true)
    expect(refspecTargetsProtectedBranch('feature/x:main')).toBe(true)
    expect(refspecTargetsProtectedBranch(':master')).toBe(true)
    expect(refspecTargetsProtectedBranch('feature/x')).toBe(false)
    expect(refspecTargetsProtectedBranch('HEAD:feature/x')).toBe(false)
  })

  it('allows feature-branch pushes', () => {
    expect(gitPushStatementTargetsProtected('git push origin feature/peanut')).toBe(false)
    expect(gitPushStatementTargetsProtected('git push origin HEAD:refs/heads/feature/x')).toBe(false)
  })

  it('rejects pushes to main/master', () => {
    expect(gitPushStatementTargetsProtected('git push origin main')).toBe(true)
    expect(gitPushStatementTargetsProtected('git push origin master')).toBe(true)
    expect(gitPushStatementTargetsProtected('git push origin HEAD:main')).toBe(true)
    expect(gitPushStatementTargetsProtected('git push origin refs/heads/main')).toBe(true)
  })
})

describe('bash policy — compound commands', () => {
  it('splits on ; and &&', () => {
    expect(splitShellStatements('a; b && c')).toEqual(['a', 'b', 'c'])
  })

  it('rejects gh pr merge', () => {
    expect(devShellCommandRejection('gh pr merge 42')).toMatch(/gh pr merge/)
    expect(devShellCommandRejection('echo ok && gh pr merge')).toMatch(/gh pr merge/)
  })

  it('rejects checkout main then merge', () => {
    expect(devShellCommandRejection('git checkout main; git merge feature/x')).toMatch(/main\/master/)
  })

  it('allows merge origin/main into feature branch', () => {
    expect(devShellCommandRejection('git merge origin/main')).toBeNull()
  })

  it('throws UserError on reject', () => {
    expect(() => assertDevShellCommandAllowed('git push origin main')).toThrow(UserError)
    expect(() => assertDevShellCommandAllowed('pnpm test')).not.toThrow()
  })
})
