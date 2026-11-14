import fs from 'node:fs'
import path from 'node:path'

/** Canonical trusted evolution directory under resolved home (symlink-safe). */
export function resolveTrustedEvolutionRoot(home: string): string {
  const resolvedHome = fs.realpathSync(path.resolve(home))
  const evolutionPath = path.join(resolvedHome, 'evolution')
  fs.mkdirSync(evolutionPath, { recursive: true })
  const evolutionReal = fs.realpathSync(evolutionPath)
  if (!evolutionReal.startsWith(resolvedHome + path.sep) && evolutionReal !== resolvedHome) {
    throw new Error('evolution root escapes trusted home')
  }
  return evolutionReal
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  const absolute = path.resolve(filePath)
  const dir = path.dirname(absolute)
  fs.mkdirSync(dir, { recursive: true })
  const dirReal = fs.realpathSync(dir)
  const body = JSON.stringify(value, null, 2)
  const tmp = path.join(dirReal, `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`)
  const fd = fs.openSync(tmp, 'wx')
  try {
    fs.writeSync(fd, body, 0, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  const target = path.join(dirReal, path.basename(absolute))
  fs.renameSync(tmp, target)
}

export function writeJsonInsideTrustedRoot(trustedRoot: string, relativeName: string, value: unknown): void {
  const root = fs.realpathSync(trustedRoot)
  const target = path.resolve(root, relativeName)
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error(`write path escapes trusted root: ${relativeName}`)
  }
  writeJsonAtomic(target, value)
}

export function readJsonFile<T>(filePath: string, trustedRoot?: string): T {
  const absolute = path.resolve(filePath)
  if (trustedRoot) {
    const root = fs.realpathSync(trustedRoot)
    const realFile = fs.realpathSync(absolute)
    if (!realFile.startsWith(root + path.sep) && realFile !== root) {
      throw new Error(`read path escapes trusted root: ${filePath}`)
    }
    return JSON.parse(fs.readFileSync(realFile, 'utf8')) as T
  }
  return JSON.parse(fs.readFileSync(absolute, 'utf8')) as T
}

/** Resolve path and ensure it stays under expectedDir (symlink-safe). */
export function resolveInsideDir(expectedDir: string, candidatePath: string): string {
  const root = fs.realpathSync(path.resolve(expectedDir))
  if (!fs.existsSync(candidatePath)) {
    const resolved = path.resolve(candidatePath)
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`path escapes evolution home: ${candidatePath}`)
    }
    throw new Error(`missing path under evolution home: ${candidatePath}`)
  }
  const resolved = fs.realpathSync(path.resolve(candidatePath))
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`path escapes evolution home: ${candidatePath}`)
  }
  return resolved
}
