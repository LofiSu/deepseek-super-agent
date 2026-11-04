/**
 * `ds-agent backup` / `ds-agent restore` command bodies.
 *
 * This module is intentionally not wired into `src/cli/main.ts` here: the CLI
 * integration PR owns that file. The standalone entry at the bottom lets an
 * operator use the commands today:
 *
 *   npx tsx src/cli/backup.ts --home .ds-agent --out ~/ds-agent-backup.db
 *   npx tsx src/cli/backup.ts --home .ds-agent --input ~/ds-agent-backup.db
 *
 * Once wired, main.ts passes the resolved state home and lets a thrown
 * UserError reach its top-level handler, which prints the message and sets a
 * non-zero exit code.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { backupStore, restoreStore, type StoreBackupResult, type StoreRestoreResult } from '../store/backup.ts'

export interface BackupCommandOptions {
  readonly home: string
  readonly out: string
  /** Pass through to `backupStore`; normally only `.db`/`.sqlite` is accepted. */
  readonly allowUnknownExtension?: boolean
}

export interface RestoreCommandOptions {
  readonly home: string
  readonly input: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

/** Snapshot the store and print a human-readable result. Throws on refusal. */
export function runBackupCommand(options: BackupCommandOptions): StoreBackupResult {
  const { home, out } = options
  const result = backupStore(home, out, {
    ...(options.allowUnknownExtension === undefined
      ? {}
      : { allowUnknownExtension: options.allowUnknownExtension }),
  })
  console.log(
    `Backed up ${path.join(path.resolve(home), 'ds-agent.db')} to ${path.resolve(out)} `
    + `(${result.bytes} bytes, schema v${result.schemaVersion}).`,
  )
  return result
}

/** Restore the store and print a human-readable result. Throws on refusal. */
export function runRestoreCommand(options: RestoreCommandOptions): StoreRestoreResult {
  const { home, input } = options
  const result = restoreStore(home, input)
  const legacy = result.schemaVersion === 0
    ? ' The backup has no schema_migrations ledger (legacy schema 0); the next ds-agent start migrates it.'
    : ''
  console.log(
    `Restored ${path.join(path.resolve(home), 'ds-agent.db')} from ${path.resolve(input)} `
    + `(${result.bytes} bytes, schema v${result.schemaVersion}).${legacy}`,
  )
  return result
}

export function backupUsage(): string {
  return [
    'Usage:',
    '  ds-agent backup --out <file.db> [--home <state-dir>] [--allow-any-extension]',
    '  ds-agent restore --input <file.db> [--home <state-dir>]',
    '',
    'The target process must be stopped before restore.',
  ].join('\n')
}

/**
 * Standalone entry used by tests and by the docs until main.ts wires the
 * commands. Returns the process exit code instead of exiting the process.
 */
export function runBackupCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(backupUsage())
    return 0
  }

  const home = flag(argv, 'home') ?? env.DS_AGENT_HOME ?? path.join(process.cwd(), '.ds-agent')
  const out = flag(argv, 'out')
  const input = flag(argv, 'input')

  if ((out === undefined) === (input === undefined)) {
    console.error(backupUsage())
    return 1
  }

  try {
    if (out !== undefined) {
      runBackupCommand({
        home,
        out,
        allowUnknownExtension: argv.includes('--allow-any-extension'),
      })
    } else {
      runRestoreCommand({ home, input: input! })
    }
    return 0
  } catch (error) {
    const command = out !== undefined ? 'backup' : 'restore'
    console.error(`ds-agent ${command}: ${errorMessage(error)}`)
    return 1
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  process.exitCode = runBackupCli()
}
