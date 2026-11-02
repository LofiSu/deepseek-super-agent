import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gatewayFromSources, gatewayConfigPath, readGatewayConfigFile } from '../src/gateway/config-file.ts'
import { gatewayProvidersFromInput } from '../src/gateway/config.ts'
import { discoverLocalEndpoints } from '../src/gateway/discover.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gwcfg-'))
  cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
  return home
}

describe('gateway config file + sources', () => {
  it('reads providers/aliases/defaultModel from gateway.config.json', () => {
    const home = tempHome()
    fs.writeFileSync(gatewayConfigPath(home), JSON.stringify({
      defaultModel: 'm1',
      providers: [{ id: 'local', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['m1'] }],
      aliases: { auto: ['local/m1'] },
    }))
    expect(readGatewayConfigFile(home)).toMatchObject({ defaultModel: 'm1' })
    const resolved = gatewayFromSources(home, {} as NodeJS.ProcessEnv)
    expect(resolved.source).toBe('file')
    expect(resolved.providers[0]).toMatchObject({ id: 'local', baseUrl: 'http://127.0.0.1:9/v1', models: ['m1'] })
    expect(resolved.aliases).toEqual({ auto: ['local/m1'] })
    expect(resolved.defaultModel).toBe('m1')
  })

  it('falls back to env when there is no config file', () => {
    const home = tempHome()
    const env = { DS_AGENT_API_BASE: 'http://y', DS_AGENT_API_KEY: 'k', DS_AGENT_API_MODEL: 'm2' } as NodeJS.ProcessEnv
    const resolved = gatewayFromSources(home, env)
    expect(resolved.source).toBe('env')
    expect(resolved.providers[0]).toMatchObject({ id: 'default', baseUrl: 'http://y' })
    expect(resolved.defaultModel).toBe('m2')
  })

  it('reports none when nothing is configured', () => {
    const home = tempHome()
    expect(gatewayFromSources(home, {} as NodeJS.ProcessEnv)).toMatchObject({ source: 'none', providers: [] })
  })

  it('normalizes raw provider input incl. presets', () => {
    const providers = gatewayProvidersFromInput(
      [{ id: 'ds', preset: 'deepseek' }],
      { DEEPSEEK_API_KEY: 'k' } as NodeJS.ProcessEnv,
    )
    expect(providers[0]).toMatchObject({ id: 'ds', baseUrl: 'https://api.deepseek.com', apiKey: 'k', models: ['deepseek-flash'] })
  })
})

describe('discoverLocalEndpoints', () => {
  it('finds a reachable local OpenAI-compatible endpoint', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/v1/models' || (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'local-model' }] }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('no address')); return }
        resolve(address.port)
      })
    })
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const found = await discoverLocalEndpoints([`http://127.0.0.1:${port}/v1`], 500)
    const hit = found.find(endpoint => endpoint.url === `http://127.0.0.1:${port}/v1`)
    expect(hit).toBeTruthy()
    expect(hit!.models).toContain('local-model')
  })
})
