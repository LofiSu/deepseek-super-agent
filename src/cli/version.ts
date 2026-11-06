import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Read the version of the package that owns the running CLI.
 *
 * Walks up from this module's directory until it finds a `package.json` whose
 * `name` is `ds-agent`. That works both from `tsx src/cli/main.ts` (repo root
 * two levels up) and from `node dist/cli/main.js` after `pnpm build` (the
 * package root two levels up), including a globally installed tarball.
 *
 * Fails closed: a missing or unreadable version is an error, never a blank
 * string or a made-up fallback.
 */
export function readPackageVersion(moduleUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(moduleUrl))
  for (;;) {
    const candidate = path.join(dir, 'package.json')
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown }
      if (pkg.name === 'ds-agent') {
        if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
          throw new Error(`ds-agent version unavailable: package.json at ${candidate} has no version`)
        }
        return pkg.version
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('ds-agent version unavailable: no package.json named "ds-agent" above the CLI entry')
}
