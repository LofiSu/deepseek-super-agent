/**
 * Embedded gateway: when a `gateway.config.json` exists and no explicit
 * `DS_AGENT_GATEWAY_URL` is set, start the gateway in-process so `ds-agent
 * chat` / `imessage` need no separate gateway process (and no Magpie).
 */

import { gatewayFromSources, readGatewayConfigFile } from './config-file.ts'
import { startGatewayServer, type GatewayHandle } from './server.ts'
import { loadOrCreateGatewayToken } from './token.ts'

export interface EmbeddedGateway {
  url: string
  token: string
  close(): Promise<void>
}

export async function startEmbeddedGateway(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmbeddedGateway | undefined> {
  if (env.DS_AGENT_GATEWAY_URL?.trim()) return undefined
  const file = readGatewayConfigFile(home)
  if (!file || !Array.isArray(file.providers) || file.providers.length === 0) return undefined
  const { providers, aliases, defaultModel } = gatewayFromSources(home, env)
  if (providers.length === 0) return undefined
  const token = loadOrCreateGatewayToken(home)
  const handle: GatewayHandle = await startGatewayServer({
    host: '127.0.0.1',
    port: 0,
    token,
    providers,
    home,
    masking: env.DS_AGENT_GATEWAY_MASKING === '1',
    ...(defaultModel ? { defaultModel } : {}),
    ...(Object.keys(aliases).length ? { aliases } : {}),
  })
  return { url: handle.url, token: handle.token, close: () => handle.close() }
}
