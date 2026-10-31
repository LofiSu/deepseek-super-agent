import { threadKey, type ThreadRef } from '../shared/types.ts'

export { threadKey }

export function parseThreadKey(key: string): ThreadRef {
  const index = key.indexOf(':')
  if (index <= 0) throw new Error(`bad thread key ${key}`)
  return { source: key.slice(0, index), id: key.slice(index + 1) }
}
