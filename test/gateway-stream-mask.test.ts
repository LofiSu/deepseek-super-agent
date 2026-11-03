import { describe, expect, it } from 'vitest'
import { Masker, deepUnmask } from '../src/gateway/mask.ts'
import { maskSseLine } from '../src/gateway/server.ts'

describe('streaming masking', () => {
  it('unmasks placeholders inside an SSE data line', () => {
    const masker = new Masker()
    const masked = masker.mask('token sk-abcdef123456 here')
    expect(masked).not.toContain('sk-abcdef123456')
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: masked } }] })}\n`
    const out = maskSseLine(line, masker)
    expect(out).toContain('sk-abcdef123456')
    expect(out).not.toContain('{{API_KEY_')
    expect(out.startsWith('data: ')).toBe(true)
  })

  it('passes [DONE] and non-data lines through', () => {
    const masker = new Masker()
    expect(maskSseLine('data: [DONE]\n', masker)).toBe('data: [DONE]\n')
    expect(maskSseLine(': keep-alive\n', masker)).toBe(': keep-alive\n')
  })

  it('deepUnmask restores nested values', () => {
    const masker = new Masker()
    const masked = masker.mask('a@b.com')
    const out = deepUnmask({ x: [masked] }, masker) as { x: string[] }
    expect(out.x[0]).toBe('a@b.com')
  })
})
