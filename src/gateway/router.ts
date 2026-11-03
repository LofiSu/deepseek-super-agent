import type { GatewayProvider } from './config.ts'

export interface RouteCandidate {
  provider: GatewayProvider
  /** Model id to send upstream (may differ from the client's when prefixed). */
  model: string
}

interface FailureState {
  count: number
  until: number
}

/**
 * Picks provider candidates for a model (or a routing alias), tracks failures
 * with an exponential cooldown, and rotates provider API keys round-robin.
 */
export class GatewayRouter {
  private readonly failures = new Map<string, FailureState>()
  private readonly keyCursor = new Map<string, number>()
  private readonly aliases: Record<string, string[]>

  constructor(
    private readonly providers: readonly GatewayProvider[],
    private readonly defaultModel?: string,
    private readonly now: () => number = () => Date.now(),
    aliases: Record<string, string[]> = {},
  ) {
    this.aliases = aliases
  }

  /** De-duplicated model catalog (provider models + routing aliases) for GET /v1/models. */
  listModels(): { id: string; provider: string }[] {
    const seen = new Map<string, string>()
    for (const provider of this.providers) {
      for (const model of provider.models ?? []) {
        if (!seen.has(model)) seen.set(model, provider.id)
      }
    }
    for (const alias of Object.keys(this.aliases)) {
      if (!seen.has(alias)) seen.set(alias, 'alias')
    }
    return [...seen].map(([id, provider]) => ({ id, provider }))
  }

  providersState(): { id: string; priority: number; cooldownUntil?: string }[] {
    const now = this.now()
    return this.providers.map(provider => {
      const failure = this.failures.get(provider.id)
      const cooling = failure != null && failure.until > now
      return {
        id: provider.id,
        priority: provider.priority ?? 0,
        ...(cooling ? { cooldownUntil: new Date(failure.until).toISOString() } : {}),
      }
    })
  }

  /** Ordered providers to try for a requested model or alias. */
  candidates(modelInput?: string): RouteCandidate[] {
    const requested = modelInput?.trim() || this.defaultModel?.trim() || ''
    const alias = this.aliases[requested]
    if (alias && alias.length > 0) {
      const expanded: RouteCandidate[] = []
      for (const entry of alias) {
        for (const candidate of this.resolveOne(entry)) {
          if (!expanded.some(item => item.provider.id === candidate.provider.id && item.model === candidate.model)) {
            expanded.push(candidate)
          }
        }
      }
      if (expanded.length > 0) return expanded
    }
    return this.resolveOne(requested)
  }

  /** Round-robin credential for a provider (spreads rate limits across keys). */
  pickKey(provider: GatewayProvider): string {
    const keys = provider.apiKeys?.length ? provider.apiKeys : provider.apiKey ? [provider.apiKey] : []
    if (keys.length === 0) return ''
    const cursor = this.keyCursor.get(provider.id) ?? 0
    this.keyCursor.set(provider.id, cursor + 1)
    return keys[cursor % keys.length]!
  }

  recordFailure(providerId: string): void {
    const current = this.failures.get(providerId) ?? { count: 0, until: 0 }
    current.count += 1
    const cooldown = Math.min(30_000, 1_000 * 2 ** Math.min(current.count - 1, 4))
    current.until = this.now() + cooldown
    this.failures.set(providerId, current)
  }

  recordSuccess(providerId: string): void {
    this.failures.delete(providerId)
  }

  private resolveOne(requested: string): RouteCandidate[] {
    // Explicit "provider/model" prefix pins the provider.
    const slash = requested.indexOf('/')
    if (slash > 0) {
      const providerId = requested.slice(0, slash)
      const provider = this.providers.find(item => item.id === providerId)
      if (provider) return [{ provider, model: requested.slice(slash + 1) }]
    }
    const ordered = this.ordered()
    const matching = ordered.filter(provider => !provider.models?.length || provider.models.includes(requested))
    const chosen = matching.length > 0 ? matching : ordered
    return chosen.map(provider => ({ provider, model: requested || provider.models?.[0] || '' }))
  }

  /** Healthy providers first (by priority), then cooled-down ones as a last resort. */
  private ordered(): GatewayProvider[] {
    const now = this.now()
    const sorted = [...this.providers].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    const healthy: GatewayProvider[] = []
    const cooling: GatewayProvider[] = []
    for (const provider of sorted) {
      if ((this.failures.get(provider.id)?.until ?? 0) > now) cooling.push(provider)
      else healthy.push(provider)
    }
    return [...healthy, ...cooling]
  }
}
