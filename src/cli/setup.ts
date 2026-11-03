import fs from 'node:fs'
import { discoverLocalEndpoints, type DiscoveredEndpoint } from '../gateway/discover.ts'
import { gatewayConfigPath } from '../gateway/config-file.ts'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'local'
}

function buildConfig(found: DiscoveredEndpoint[]): Record<string, unknown> {
  const providers = found.map(endpoint => ({
    id: slug(endpoint.label),
    baseUrl: endpoint.url,
    apiKey: '',
    models: endpoint.models.slice(0, 8),
  }))
  const auto: string[] = []
  for (const provider of providers) {
    for (const model of provider.models) auto.push(`${provider.id}/${model}`)
  }
  return {
    defaultModel: auto[0] ?? 'auto',
    providers,
    aliases: auto.length > 0 ? { auto: auto.slice(0, 8) } : {},
  }
}

/**
 * `ds-agent setup` — discover local OpenAI-compatible products and scaffold
 * `~/.ds-agent/gateway.config.json`. Pass `--write` to save; `--url` to probe an
 * extra endpoint. Hint: add an `apiKey` to any provider that needs auth.
 */
export async function runSetupCommand(home: string): Promise<void> {
  const extra = flag('url')
  const write = process.argv.includes('--write')
  const found = await discoverLocalEndpoints(extra ? [extra] : [])
  if (found.length === 0) {
    console.log('No local OpenAI-compatible endpoint found.')
    console.log('Start your local product, or point at one explicitly:  pnpm ds-agent setup --url http://host:port/v1')
    return
  }
  console.log('Discovered local endpoints:')
  for (const endpoint of found) {
    console.log(`  - ${endpoint.label.padEnd(10)} ${endpoint.url}  models=${endpoint.models.length}`)
  }
  const config = buildConfig(found)
  const text = `${JSON.stringify(config, null, 2)}\n`
  if (write) {
    fs.mkdirSync(home, { recursive: true })
    // The file will hold provider keys once the operator fills them in.
    fs.writeFileSync(gatewayConfigPath(home), text, { mode: 0o600 })
    fs.chmodSync(gatewayConfigPath(home), 0o600)
    console.log(`\nWrote ${gatewayConfigPath(home)}`)
    console.log('Add an "apiKey" to any provider that needs auth, then run: pnpm ds-agent gateway')
  } else {
    console.log(`\nProposed ${gatewayConfigPath(home)} (re-run with --write to save):\n${text}`)
  }
}
