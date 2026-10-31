/** Speculative work stays silent until a report explicitly delivers. */
export function isSpeculative(meta: Record<string, unknown>, strength: string): boolean {
  return meta.speculate === true || strength === 'maybe'
}

export function maySurface(speculative: boolean, deliver: boolean | undefined): boolean {
  if (!speculative) return deliver !== false
  return deliver === true
}
