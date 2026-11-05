import type { ObjectRef } from '../shared/types.ts'

/** Inline keeps a short summary plus the spill id. The body is recalled with read_object. */
export const INLINE_LIMIT = 180

export interface Recall {
  inline: string
  spillId?: string
  bytes: number
  /** Next-hop handles inlined even when the body stays in the window. */
  refs: ObjectRef[]
}

export function inlineOrSpill(
  text: string,
  put: (body: string, refs: readonly ObjectRef[]) => string,
  refs: readonly ObjectRef[] = [],
): Recall {
  const bytes = Buffer.byteLength(text)
  if (text.length <= INLINE_LIMIT) return { inline: text, bytes, refs: [...refs] }
  const id = put(text, refs)
  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 72)
  return { inline: `${summary}… spillId=${id}`, spillId: id, bytes, refs: [...refs] }
}
