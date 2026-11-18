import { describe, expect, it } from 'vitest'
import { normalizePeanutBranch } from '../src/env/git-workspace.ts'
import { UserError } from '../src/shared/errors.ts'

describe('normalizePeanutBranch', () => {
  it('uses explicit slug under peanut/', () => {
    expect(normalizePeanutBranch('my-feature', 'peanut/other')).toBe('peanut/my-feature')
  })

  it('uses HEAD when branch omitted', () => {
    expect(normalizePeanutBranch(undefined, 'peanut/from-head')).toBe('peanut/from-head')
  })

  it('refuses explicit main even when HEAD is peanut/ok', () => {
    expect(() => normalizePeanutBranch('main', 'peanut/ok')).toThrow(UserError)
    expect(() => normalizePeanutBranch('peanut/main', 'peanut/ok')).toThrow(UserError)
    expect(() => normalizePeanutBranch('master', 'peanut/ok')).toThrow(UserError)
  })

  it('refuses invalid slugs', () => {
    expect(() => normalizePeanutBranch('foo:main', 'peanut/x')).toThrow(UserError)
    expect(() => normalizePeanutBranch('--force', 'peanut/x')).toThrow(UserError)
    expect(() => normalizePeanutBranch('has space', 'peanut/x')).toThrow(UserError)
  })

  it('requires peanut/ HEAD when branch omitted', () => {
    expect(() => normalizePeanutBranch(undefined, 'main')).toThrow(UserError)
    expect(() => normalizePeanutBranch(undefined, 'peanut/main')).toThrow(UserError)
  })
})
