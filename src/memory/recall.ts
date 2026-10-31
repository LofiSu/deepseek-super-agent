import { UserError } from '../shared/errors.ts'

/** Inline keeps a short summary plus the spill id. The body is recalled with read_object. */
export const INLINE_LIMIT = 180
/** UTF-8 budget. A short string of wide characters still spills. */
export const INLINE_BYTE_LIMIT = 400
/** Default read_object page, in Unicode code points. */
export const READ_OBJECT_LIMIT = 480

export interface Recall {
  inline: string
  spillId?: string
  bytes: number
}

function codePoints(text: string): string[] {
  return Array.from(text)
}

function headOf(text: string, max: number): string {
  const summary = codePoints(text.replace(/\s+/g, ' ').trim()).slice(0, max).join('')
  return summary || '(blank)'
}

export function inlineOrSpill(text: string, put: (body: string) => string): Recall {
  const bytes = Buffer.byteLength(text)
  if (text.length <= INLINE_LIMIT && bytes <= INLINE_BYTE_LIMIT) return { inline: text, bytes }
  const id = put(text)
  return { inline: `${headOf(text, 72)}… spillId=${id}`, spillId: id, bytes }
}

export interface ReadObjectPage {
  id: string
  summary: string
  text: string
  bytes: number
  offset: number
  truncated: boolean
  nextOffset?: number
  neighbors: string[]
}

function clampOffset(offset: number | undefined, length: number): number {
  if (offset == null || !Number.isFinite(offset)) return 0
  const whole = Math.trunc(offset)
  if (whole < 0) return 0
  if (whole > length) return length
  return whole
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return READ_OBJECT_LIMIT
  const whole = Math.trunc(limit)
  if (whole <= 0) return READ_OBJECT_LIMIT
  return whole
}

/**
 * Page a spilled body. `offset` and `limit` count Unicode code points.
 * A missing id throws. An offset past the end returns an empty page with no nextOffset.
 */
export function readObject(input: {
  id: string
  body: string | undefined
  offset?: number
  limit?: number
  neighbors?: string[]
}): ReadObjectPage {
  const id = input.id.trim()
  if (!id) throw new UserError('read_object needs an id')
  if (input.body == null) throw new UserError(`unknown spill ${id}`)
  const chars = codePoints(input.body)
  const offset = clampOffset(input.offset, chars.length)
  const limit = clampLimit(input.limit)
  const end = Math.min(chars.length, offset + limit)
  const truncated = end < chars.length
  const neighbors = [...new Set((input.neighbors ?? []).filter(item => item && item !== id))]
  return {
    id,
    summary: headOf(input.body, 72),
    text: chars.slice(offset, end).join(''),
    bytes: Buffer.byteLength(input.body),
    offset,
    truncated,
    nextOffset: truncated ? end : undefined,
    neighbors,
  }
}

export function spillIdsIn(text: string): string[] {
  return [...text.matchAll(/spillId=(spill_[A-Za-z0-9_]+)/g)].map(match => match[1] ?? '').filter(Boolean)
}

export interface SpillLink {
  spillId?: string
  inputs?: { spillId?: string }[]
}

/** Other spill ids on records that already reference `id`, plus ids cited inside the body. */
export function linkedSpillIds(records: readonly SpillLink[], id: string, body = ''): string[] {
  const extra: string[] = []
  for (const record of records) {
    const ids = [record.spillId, ...(record.inputs ?? []).map(input => input.spillId)]
      .filter((item): item is string => Boolean(item))
    if (!ids.includes(id)) continue
    extra.push(...ids)
  }
  extra.push(...spillIdsIn(body))
  return [...new Set(extra.filter(item => item !== id))]
}
