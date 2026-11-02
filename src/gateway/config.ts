/**
 * Local OpenAI/Anthropic/Gemini-compatible gateway (a TypeScript
 * re-implementation of the "Magpie" gateway role).
 *
 * Credentials are yours: provider keys/tokens are read from env or the project
 * vault. Nothing here scrapes tokens from other apps or bypasses a provider's
 * quota. For subscription backends you must supply your own token (see the
 * `auth` / `apiKeyEnv` fields) — the gateway just forwards it.
 */

import { PROVIDER_PRESETS } from '../harness/providers.ts'

/** How the gateway presents a credential to an upstream. */
export type GatewayAuth = 'bearer' | 'x-api-key' | 'header' | 'none'

export interface GatewayProvider {
  id: string
  /** OpenAI-compatible base, e.g. `https://api.deepseek.com` or `http://127.0.0.1:3425/v1`. */
  baseUrl: string
  /** Primary credential (empty allowed for `auth: 'none'`). */
  apiKey: string
  /** Extra credentials rotated round-robin to spread rate limits. */
  apiKeys?: string[]
  auth?: GatewayAuth
  /** Header name when `auth: 'header'`. */
  authHeader?: string
  /** Model ids this provider serves. Empty/omitted means "any model". */
  models?: string[]
  /** Higher wins when several providers serve the same model. Default 0. */
  priority?: number
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface GatewayConfig {
  host: string
  port: number
  token: string
  providers: GatewayProvider[]
  defaultModel?: string
  /** Routing groups: alias -> ordered list of "provider/model" or "model" entries. */
  aliases?: Record<string, string[]>
}

interface GatewayProviderInput {
  id?: string
  /** Built-in preset id/alias (deepseek, openai, anthropic, gemini, ...). */
  preset?: string
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  apiKeys?: string[]
  auth?: GatewayAuth
  authHeader?: string
  models?: string[]
  priority?: number
  headers?: Record<string, string>
  timeoutMs?: number
}

export function providerBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** Join a provider base with an upstream path (`/chat/completions`, `/models`, ...). */
export function upstreamUrl(provider: GatewayProvider, path: string): string {
  return `${providerBaseUrl(provider.baseUrl)}${path.startsWith('/') ? path : `/${path}`}`
}

function findPreset(name: string) {
  const id = name.toLowerCase()
  return PROVIDER_PRESETS.find(preset => preset.id === id || preset.aliases.includes(id))
}

function presetKey(env: NodeJS.ProcessEnv, preset: { keyEnv: readonly string[] }): string {
  for (const name of preset.keyEnv) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return ''
}

function normalizeProvider(input: GatewayProviderInput, env: NodeJS.ProcessEnv, index: number): GatewayProvider {
  if (!input || typeof input !== 'object') throw new Error(`provider ${index} must be an object`)
  const id = String(input.id ?? input.preset ?? `p${index}`).trim()
  if (!id) throw new Error(`provider ${index} needs an id`)
  const preset = input.preset ? findPreset(input.preset) : undefined
  if (input.preset && !preset) throw new Error(`provider ${id} references unknown preset "${input.preset}"`)
  const baseUrl = String(input.baseUrl ?? preset?.base ?? '').trim()
  if (!baseUrl) throw new Error(`provider ${id} needs baseUrl or a known preset`)
  const apiKey = String(input.apiKey ?? '').trim()
    || (input.apiKeyEnv ? String(env[input.apiKeyEnv] ?? '').trim() : '')
    || (preset ? presetKey(env, preset) : '')
  const models = Array.isArray(input.models)
    ? input.models.map(String)
    : preset
      ? [env.DS_AGENT_API_MODEL?.trim() || preset.defaultModel]
      : undefined
  const apiKeys = Array.isArray(input.apiKeys) ? input.apiKeys.map(String) : undefined
  return {
    id,
    baseUrl,
    apiKey,
    ...(apiKeys ? { apiKeys } : {}),
    ...(input.auth ? { auth: input.auth } : {}),
    ...(input.authHeader ? { authHeader: input.authHeader } : {}),
    ...(models ? { models } : {}),
    priority: Number(input.priority ?? 0) || 0,
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.timeoutMs && Number.isFinite(input.timeoutMs) ? { timeoutMs: input.timeoutMs } : {}),
  }
}

/**
 * Normalize a raw provider array (from a config file or env JSON). Exported so
 * the config-file loader and env loader share one code path.
 */
export function gatewayProvidersFromInput(inputs: unknown, env: NodeJS.ProcessEnv = process.env): GatewayProvider[] {
  if (!Array.isArray(inputs)) throw new Error('providers must be a JSON array')
  return inputs.map((item, index) => normalizeProvider(item as GatewayProviderInput, env, index))
}

/**
 * Build the provider list from `DS_AGENT_GATEWAY_PROVIDERS` (a JSON array).
 * With no JSON, fall back to the single BYOM provider in
 * `DS_AGENT_API_BASE` + `DS_AGENT_API_KEY`.
 */
export function gatewayProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayProvider[] {
  const raw = env.DS_AGENT_GATEWAY_PROVIDERS?.trim()
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('DS_AGENT_GATEWAY_PROVIDERS is not valid JSON')
    }
    return gatewayProvidersFromInput(parsed, env)
  }
  const baseUrl = env.DS_AGENT_API_BASE?.trim()
  const apiKey = env.DS_AGENT_API_KEY?.trim()
  if (baseUrl && apiKey) {
    const model = env.DS_AGENT_API_MODEL?.trim()
    return [{ id: 'default', baseUrl, apiKey, priority: 0, ...(model ? { models: [model] } : {}) }]
  }
  return []
}

/** Routing groups from `DS_AGENT_GATEWAY_ALIASES` (JSON object of name -> string[]). */
export function gatewayAliasesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string[]> {
  const raw = env.DS_AGENT_GATEWAY_ALIASES?.trim()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('DS_AGENT_GATEWAY_ALIASES is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DS_AGENT_GATEWAY_ALIASES must be a JSON object')
  }
  const aliases: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) throw new Error(`alias "${key}" must be an array`)
    aliases[key] = value.map(String)
  }
  return aliases
}
