import { Store } from '../store/sqlite.ts'
import {
  DEFAULT_UI_PORT,
  MIN_TOKEN_LENGTH,
  isLoopbackHost,
  startUiServer,
  type UiServerHandle,
} from '../ui/server.ts'

export interface UiCommandOptions {
  /** Loopback host to accept; the server always binds 127.0.0.1. */
  host?: string
  port?: number
  /** Explicit token; otherwise --token, then DS_AGENT_UI_TOKEN. */
  token?: string
}

/** Callback shape for the follow-up `main.ts` wiring PR. */
export type UiCommandRegistrar = (name: 'ui', run: (home: string) => Promise<void>) => void

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

function resolvePort(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit
  const raw = flag('port')
  if (raw === undefined) return DEFAULT_UI_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid ui port: ${raw}`)
  return port
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveToken(explicit: string | undefined): string {
  const token = (explicit ?? flag('token') ?? process.env.DS_AGENT_UI_TOKEN ?? '').trim()
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `ds-agent ui requires a token of at least ${MIN_TOKEN_LENGTH} characters; `
      + 'set DS_AGENT_UI_TOKEN (preferred, not visible in process listings) or pass --token',
    )
  }
  return token
}

/**
 * `ds-agent ui` — read-only loopback dashboard over persisted state.
 *
 * Opens exactly one Store, starts the loopback-only HTTP server, and closes the
 * Store on SIGINT/SIGTERM. Metrics are re-read from the store home on every
 * request, so another process's counters appear without a restart. It
 * constructs no model and starts no daemon. Command registration in `main.ts`
 * is a follow-up wiring PR (see docs/UI.md) so this module can land
 * independently.
 */
export async function runUi(home: string, options: UiCommandOptions = {}): Promise<void> {
  const host = options.host ?? '127.0.0.1'
  if (!isLoopbackHost(host)) {
    throw new Error(`ds-agent ui only binds loopback addresses; refusing host ${host}`)
  }
  const token = resolveToken(options.token)
  const port = resolvePort(options.port)

  let store: Store
  try {
    store = new Store(home)
  } catch (error) {
    throw new Error(`ds-agent ui: cannot open store at ${home}: ${errorMessage(error)}`)
  }

  let handle: UiServerHandle
  try {
    handle = await startUiServer({ home, store, host, port, token })
  } catch (error) {
    if (store.isOpen) store.close()
    throw new Error(`ds-agent ui: cannot start server on 127.0.0.1:${port}: ${errorMessage(error)}`)
  }

  console.log(`ds-agent ui listening on ${handle.url} (read-only)`)
  console.log(`  home:      ${home}`)
  console.log('  endpoints: /  /api/snapshot  /api/events (SSE every 2s)')
  console.log('  bind:      127.0.0.1 only; Ctrl+C to stop')

  await new Promise<void>(resolve => {
    const stop = (signal: NodeJS.Signals): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      void handle.close()
        .catch(error => {
          console.error(`ds-agent ui: shutdown failed: ${errorMessage(error)}`)
          process.exitCode = 1
        })
        .finally(() => {
          if (store.isOpen) store.close()
          console.log(`ds-agent ui stopped${signal ? ` (${signal})` : ''}`)
          resolve()
        })
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

/**
 * Hook for the follow-up CLI wiring PR. The function is exported now so the
 * command descriptor and behavior are testable without touching main.ts.
 */
export function registerUi(register: UiCommandRegistrar): void {
  register('ui', home => runUi(home))
}
