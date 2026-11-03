import fs from 'node:fs'
import path from 'node:path'
import { gatewayFromSources } from '../gateway/config-file.ts'
import { startGatewayServer } from '../gateway/server.ts'
import { gatewayTokenPath, loadOrCreateGatewayToken } from '../gateway/token.ts'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

/**
 * `ds-agent gateway` — start a local OpenAI-compatible gateway.
 *
 * Providers come from `DS_AGENT_GATEWAY_PROVIDERS` (JSON array) or the single
 * BYOM provider in `DS_AGENT_API_BASE` + `DS_AGENT_API_KEY`. The local bearer
 * token is generated and persisted (mode 0600) so ds-agent can auto-read it.
 */
export async function runGatewayCommand(home: string): Promise<void> {
  const port = Number(flag('port') ?? process.env.DS_AGENT_GATEWAY_PORT ?? 4319)
  if (!Number.isFinite(port) || port < 0 || port > 65535) throw new Error(`invalid gateway port: ${port}`)
  const host = flag('host') ?? process.env.DS_AGENT_GATEWAY_HOST ?? '127.0.0.1'
  const token = loadOrCreateGatewayToken(home, flag('token') ?? process.env.DS_AGENT_GATEWAY_TOKEN)
  const { providers, aliases, defaultModel: fileDefault, masking: fileMasking, source } = gatewayFromSources(home)
  if (providers.length === 0) {
    throw new Error(
      'no providers configured: run `pnpm ds-agent setup` to write gateway.config.json, '
      + 'or set DS_AGENT_GATEWAY_PROVIDERS / DS_AGENT_API_BASE + DS_AGENT_API_KEY',
    )
  }
  const defaultModel = process.env.DS_AGENT_GATEWAY_MODEL?.trim()
    || process.env.DS_AGENT_API_MODEL?.trim()
    || fileDefault
    || providers[0]?.models?.[0]

  const masking = fileMasking === true || process.env.DS_AGENT_GATEWAY_MASKING === '1'
  const handle = await startGatewayServer({
    host,
    port,
    token,
    providers,
    home,
    masking,
    ...(defaultModel ? { defaultModel } : {}),
    ...(Object.keys(aliases).length ? { aliases } : {}),
  })
  fs.mkdirSync(home, { recursive: true })
  const info = {
    url: handle.url,
    tokenPath: gatewayTokenPath(home),
    providers: providers.map(provider => provider.id),
    defaultModel: defaultModel ?? null,
    aliases: Object.keys(aliases),
  }
  fs.writeFileSync(path.join(home, 'gateway.json'), `${JSON.stringify(info, null, 2)}\n`)

  console.log(`ds-agent gateway listening on ${handle.url}`)
  console.log(`  token:     ${handle.token}`)
  console.log(`  saved:     ${gatewayTokenPath(home)} (0600) + ${path.join(home, 'gateway.json')}`)
  console.log(`  providers: ${providers.map(provider => provider.id).join(', ')}${defaultModel ? `  defaultModel=${defaultModel}` : ''}  (source=${source})`)
  if (Object.keys(aliases).length) console.log(`  aliases:   ${Object.keys(aliases).join(', ')}`)
  console.log(`  plugins:   ${handle.plugins.join(', ')}${masking ? '  (masking on)' : ''}`)
  console.log(`  point ds-agent at it:  export DS_AGENT_GATEWAY_URL=${handle.url}`)

  const shutdown = (): void => {
    void handle.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await new Promise<void>(() => {
    // Stay alive until a signal arrives.
  })
}
