import type { EnvPort } from './ports.ts'
import { SCHEMA } from '../store/schema.ts'

/** Store holds session/domain state only. Env holds workspace/process only. */
export const STORE_ENV_BOUNDARY = {
  storeOwns: ['sessions', 'tickets', 'jobs', 'spills', 'replies', 'subscriptions', 'events'] as const,
  envOwns: ['workspace', 'bash', 'files', 'child-env', 'vault-injection'] as const,
  forbidden: [
    'Store must not persist secret values',
    'Env must not hold Session / Ticket / Assignment state',
    'Daemon must not hold Session state (T38/T40)',
  ] as const,
} as const

const ENV_METHOD_DENYLIST = [
  'appendSession',
  'createTicket',
  'receive',
  'decide',
  'reply',
  'listSessions',
] as const

export function assertEnvHasNoSessionApis(env: EnvPort): void {
  for (const name of ENV_METHOD_DENYLIST) {
    if (name in (env as object)) {
      throw new Error(`Store/Env boundary violated: EnvPort exposes ${name}`)
    }
  }
}

export function assertSchemaHasNoSecretColumns(schema: string = SCHEMA): void {
  const lower = schema.toLowerCase()
  for (const bad of ['password', 'api_key', 'secret_value', 'token_value']) {
    if (lower.includes(bad)) {
      throw new Error(`Store/Env boundary violated: SCHEMA mentions ${bad}`)
    }
  }
}

export function assertStoreEnvSeparation(env: EnvPort): void {
  assertEnvHasNoSessionApis(env)
  assertSchemaHasNoSecretColumns()
}
