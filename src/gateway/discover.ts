/**
 * Discover local, OpenAI-compatible endpoints so a user can reverse-proxy
 * whatever LLM product they already run locally — no Magpie install required.
 *
 * Only probes `/models` (unauthenticated). A product that needs a token will not
 * show up until you add it to the config with its key; we never read a product's
 * stored credentials.
 */
export interface DiscoveredEndpoint {
  label: string
  url: string
  models: string[]
}

const KNOWN_LOCAL: DiscoveredEndpoint[] = [
  { label: 'Magpie', url: 'http://127.0.0.1:3425/v1', models: [] },
  { label: 'Ollama', url: 'http://127.0.0.1:11434/v1', models: [] },
  { label: 'LM Studio', url: 'http://127.0.0.1:1234/v1', models: [] },
  { label: 'llama.cpp', url: 'http://127.0.0.1:8080/v1', models: [] },
  { label: 'vLLM', url: 'http://127.0.0.1:8000/v1', models: [] },
]

export async function discoverLocalEndpoints(
  extra: string[] = [],
  timeoutMs = 800,
): Promise<DiscoveredEndpoint[]> {
  const candidates: DiscoveredEndpoint[] = [
    ...KNOWN_LOCAL,
    ...extra.map(url => ({ label: url, url, models: [] })),
  ]
  const results: DiscoveredEndpoint[] = []
  await Promise.all(candidates.map(async candidate => {
    const base = candidate.url.replace(/\/+$/, '')
    try {
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return
      const json = await res.json() as { data?: { id?: unknown }[] }
      const models = (json.data ?? []).map(model => String(model.id ?? '')).filter(Boolean)
      results.push({ label: candidate.label, url: base, models })
    } catch {
      // Unreachable / not OpenAI-compatible; ignore.
    }
  }))
  return results.sort((left, right) => left.label.localeCompare(right.label))
}
