import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEmbeddedGateway } from '../src/gateway/embedded.ts'
import { gatewayConfigPath } from '../src/gateway/config-file.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { reject(new Error('no address')); return }
      resolve(address.port)
    })
  })
}

async function startFakeUpstream(): Promise<number> {
  const server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      if ((req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm1' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } }))
    })
  })
  const port = await listen(server)
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return port
}

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-embed-'))
  cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
  return home
}

describe('embedded gateway', () => {
  it('starts in-process from gateway.config.json and is reachable', async () => {
    const upstream = await startFakeUpstream()
    const home = tempHome()
    fs.writeFileSync(gatewayConfigPath(home), JSON.stringify({
      defaultModel: 'm1',
      providers: [{ id: 'local', baseUrl: `http://127.0.0.1:${upstream}`, apiKey: '', models: ['m1'] }],
    }))
    const embedded = await startEmbeddedGateway(home, {} as NodeJS.ProcessEnv)
    expect(embedded).toBeTruthy()
    cleanup.push(async () => { await embedded!.close() })
    const health = await fetch(`${embedded!.url}/health`)
    expect(health.status).toBe(200)
    expect(embedded!.token).toMatch(/^gw_/)
  })

  it('does nothing when DS_AGENT_GATEWAY_URL is already set', async () => {
    const home = tempHome()
    fs.writeFileSync(gatewayConfigPath(home), JSON.stringify({ providers: [{ id: 'x', baseUrl: 'http://x', apiKey: '', models: ['m'] }] }))
    const embedded = await startEmbeddedGateway(home, { DS_AGENT_GATEWAY_URL: 'http://127.0.0.1:9999' } as NodeJS.ProcessEnv)
    expect(embedded).toBeUndefined()
  })

  it('does nothing without a config file', async () => {
    const home = tempHome()
    expect(await startEmbeddedGateway(home, {} as NodeJS.ProcessEnv)).toBeUndefined()
  })
})
