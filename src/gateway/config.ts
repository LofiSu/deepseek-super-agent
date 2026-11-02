/**
 * Local OpenAI-compatible gateway (a TypeScript re-implementation of the
 * "Magpie" role: one local endpoint that fronts several upstream providers).
 *
 * Credentials are yours: each provider's key is read from env or the project
 * vault. Nothing here scrapes tokens from other apps or bypasses a provider's
 * quota — you must have a legitimate key for every upstream you configure.
 */

export interface GatewayProvider {
  id: string
  /** OpenAI-compatible base, e.g. `https://api.deepseek.com` or `http://127.0.0.1:3425/v1`. */
  baseUrl: string
  apiKey: string
  /** Model ids this provider serves. Empty/omitted means "any model". */
  models?: string[]
  /** Higher wins when several providers serve the same model. Default 0. */
  priority?: number
  /** Extra upstream headers. */
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface GatewayConfig {
  host: string
  port: number
  /** Local bearer token every /v1 request must present. */
  token: string
  providers: GatewayProvider[]
  defaultModel?: string
}

interface GatewayProviderInput {
  id?: string
  baseUrl?: string
  apiKey?: string
  /** Read the key from this env var instead of inlining it in JSON. */
  apiKeyEnv?: string
  models?: string[]
  priority?: number
  headers?: Record<string, string>
  timeoutMs?: number
}

export function providerBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** Join a provider base with an OpenAI path (`/chat/completions`, `/models`). */
export function upstreamUrl(provider: GatewayProvider, path: string): string {
  return `${providerBaseUrl(provider.baseUrl)}${path.startsWith('/') ? path : `/${path}`}`
}

function normalizeProvider(input: GatewayProviderInput, env: NodeJS.ProcessEnv, index: number): GatewayProvider {
  if (!input || typeof input !== 'object') throw new Error(`provider ${index} must be an object`)
  const id = String(input.id ?? `p${index}`).trim()
  if (!id) throw new Error(`provider ${index} needs an id`)
  const baseUrl = String(input.baseUrl ?? '').trim()
  if (!baseUrl) throw new Error(`provider ${id} needs baseUrl`)
  const apiKey = String(input.apiKey ?? '').trim()
    || (input.apiKeyEnv ? String(env[input.apiKeyEnv] ?? '').trim() : '')
  return {
    id,
    baseUrl,
    apiKey,
    ...(Array.isArray(input.models) ? { models: input.models.map(String) } : {}),
    priority: Number(input.priority ?? 0) || 0,
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.timeoutMs && Number.isFinite(input.timeoutMs) ? { timeoutMs: input.timeoutMs } : {}),
  }
}

/**
 * Build the provider list from `DS_AGENT_GATEWAY_PROVIDERS` (a JSON array).
 * With no JSON, fall back to the single BYOM provider in
 * `DS_AGENT_API_BASE` + `DS_AGENT_API_KEY` so the gateway can wrap the existing
 * upstream (e.g. Magpie) with zero reconfiguration.
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
    if (!Array.isArray(parsed)) throw new Error('DS_AGENT_GATEWAY_PROVIDERS must be a JSON array')
    return parsed.map((item, index) => normalizeProvider(item as GatewayProviderInput, env, index))
  }
  const baseUrl = env.DS_AGENT_API_BASE?.trim()
  const apiKey = env.DS_AGENT_API_KEY?.trim()
  if (baseUrl && apiKey) {
    const model = env.DS_AGENT_API_MODEL?.trim()
    return [{ id: 'default', baseUrl, apiKey, priority: 0, ...(model ? { models: [model] } : {}) }]
  }
  return []
}
