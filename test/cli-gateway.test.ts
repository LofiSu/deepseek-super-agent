import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { startGatewayServer } = vi.hoisted(() => ({
  startGatewayServer: vi.fn(),
}))

vi.mock('../src/gateway/server.ts', () => ({ startGatewayServer }))

import { gatewayTokenPath } from '../src/gateway/token.ts'
import { runGatewayCommand } from '../src/cli/gateway.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  while (cleanup.length > 0) await cleanup.pop()!()
})

describe('gateway CLI token label', () => {
  it('reports an explicit token as supplied rather than as a token-file path', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cli-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    startGatewayServer.mockResolvedValue({
      url: 'http://127.0.0.1:4319',
      token: 'cli-explicit-secret',
      plugins: [],
      close: async () => {},
    })

    const logs: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalArgv = process.argv
    process.argv = ['node', 'ds-agent', 'gateway', '--token', 'cli-explicit-secret']
    vi.stubEnv('DS_AGENT_GATEWAY_PROVIDERS', JSON.stringify([
      { id: 'fake', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', models: ['m'] },
    ]))
    vi.stubEnv('DS_AGENT_API_BASE', '')
    vi.stubEnv('DS_AGENT_API_KEY', '')
    vi.stubEnv('DS_AGENT_API_MODEL', '')
    vi.stubEnv('DS_AGENT_GATEWAY_MODEL', '')
    vi.stubEnv('DS_AGENT_GATEWAY_TOKEN', '')

    try {
      // A successful runGatewayCommand stays alive until a signal arrives; the
      // startup output and gateway.json are written before that.
      void runGatewayCommand(home).catch(() => {})
      await vi.waitFor(() => { expect(log).toHaveBeenCalled() })

      const output = logs.join('\n')
      expect(output).toContain('supplied via --token / DS_AGENT_GATEWAY_TOKEN')
      expect(output).not.toContain(gatewayTokenPath(home))
      expect(output).not.toContain('cli-explicit-secret')
      expect(startGatewayServer).toHaveBeenCalledTimes(1)
      expect(startGatewayServer.mock.calls[0]![0]).toMatchObject({ token: 'cli-explicit-secret' })

      const info = JSON.parse(fs.readFileSync(path.join(home, 'gateway.json'), 'utf8')) as { tokenPath: unknown }
      expect(info.tokenPath).toBeNull()
    } finally {
      process.argv = originalArgv
    }
  })
})
