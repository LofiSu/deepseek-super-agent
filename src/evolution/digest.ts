import { createHash } from 'node:crypto'
import fs from 'node:fs'

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function sha256File(filePath: string): string {
  return sha256Hex(fs.readFileSync(filePath))
}

export function stableJsonDigest(value: unknown): string {
  return sha256Hex(JSON.stringify(value))
}
