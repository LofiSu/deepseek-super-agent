import fs from 'node:fs'
import path from 'node:path'
import {
  gatewayAliasesFromEnv,
  gatewayProvidersFromEnv,
  gatewayProvidersFromInput,
  type GatewayProvider,
} from './config.ts'

/**
 * A `gateway.config.json` lets end users describe local products (whatever they
 * already run: Magpie, Ollama, LM Studio, a vendor CLI's local port, a cloud
 * key, ...) once, and `ds-agent gateway` picks it up. No Magpie install needed;
 * the gateway is this project's own reverse proxy.
 */
export interface GatewayFile {
  providers?: unknown
  aliases?: Record<string, string[]>
  defaultModel?: string
}

export interface GatewaySource {
  providers: GatewayProvider[]
  aliases: Record<string, string[]>
  defaultModel?: string
  source: 'file' | 'env' | 'none'
}

export function gatewayConfigPath(home: string): string {
  return path.join(home, 'gateway.config.json')
}

export function readGatewayConfigFile(home: string): GatewayFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(gatewayConfigPath(home), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as GatewayFile
  } catch {
    return undefined
  }
}

/**
 * Resolve providers/aliases from a config file first, then env. Priority:
 * `~/.ds-agent/gateway.config.json` > `DS_AGENT_GATEWAY_PROVIDERS` > BYOM env.
 */
export function gatewayFromSources(home: string, env: NodeJS.ProcessEnv = process.env): GatewaySource {
  const file = readGatewayConfigFile(home)
  if (file && Array.isArray(file.providers) && file.providers.length > 0) {
    const aliases = file.aliases && typeof file.aliases === 'object' ? file.aliases : {}
    return {
      providers: gatewayProvidersFromInput(file.providers, env),
      aliases,
      ...(typeof file.defaultModel === 'string' && file.defaultModel.trim() ? { defaultModel: file.defaultModel.trim() } : {}),
      source: 'file',
    }
  }
  const providers = gatewayProvidersFromEnv(env)
  if (providers.length > 0) {
    const defaultModel = env.DS_AGENT_GATEWAY_MODEL?.trim() || env.DS_AGENT_API_MODEL?.trim()
    return { providers, aliases: gatewayAliasesFromEnv(env), ...(defaultModel ? { defaultModel } : {}), source: 'env' }
  }
  return { providers: [], aliases: {}, source: 'none' }
}
