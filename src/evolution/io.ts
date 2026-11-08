import fs from 'node:fs'
import path from 'node:path'

export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const body = JSON.stringify(value, null, 2)
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, filePath)
  fs.writeFileSync(`${filePath}.sha256`, body.length.toString(), 'utf8')
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}
