/** Inline keeps a short summary plus the spill id. The body is recalled with read_object. */
export const INLINE_LIMIT = 180

export interface Recall {
  inline: string
  spillId?: string
  bytes: number
}

export function inlineOrSpill(text: string, put: (body: string) => string): Recall {
  const bytes = Buffer.byteLength(text)
  if (text.length <= INLINE_LIMIT) return { inline: text, bytes }
  const id = put(text)
  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 72)
  return { inline: `${summary}… spillId=${id}`, spillId: id, bytes }
}
