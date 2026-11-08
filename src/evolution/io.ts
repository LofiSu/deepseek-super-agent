import fs from 'node:fs'
import path from 'node:path'

export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const body = JSON.stringify(value, null, 2)
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, filePath)
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

/** Resolve path and ensure it stays under expectedDir (symlink-safe). */
export function resolveInsideDir(expectedDir: string, candidatePath: string): string {
  const root = fs.realpathSync(expectedDir)
  const resolved = fs.realpathSync(path.resolve(candidatePath))
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`path escapes evolution home: ${candidatePath}`)
  }
  return resolved
}
