import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONNECTORS_FILE,
  loadConnectorConfig,
  normalizeConnectorConfig,
  parseGoogleCredentials,
  resolveGoogleCredentials,
} from '../src/connectors/config.ts'
import { GOOGLE_SERVICES } from '../src/connectors/types.ts'

const homes: string[] = []

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-connectors-config-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

const credentials = {
  clientId: 'client-id',
  clientSecret: 'client-secret-value',
  refreshToken: 'refresh-token-value',
}

describe('connectors config', () => {
  it('is disabled with safe defaults when the file is missing or blank', () => {
    const missing = loadConnectorConfig(tempHome(), {})
    expect(missing.enabled).toBe(false)
    expect(missing.google.services).toEqual([...GOOGLE_SERVICES])
    expect(missing.wake.enabled).toBe(false)
    expect(missing.wake.source).toBe('cli')
    expect(missing.wake.thread).toBe('local')

    const home = tempHome()
    fs.writeFileSync(path.join(home, CONNECTORS_FILE), '   \n')
    expect(loadConnectorConfig(home, {}).enabled).toBe(false)
  })

  it('fails loudly on malformed JSON, unknown keys, and bad values', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, CONNECTORS_FILE), '{')
    expect(() => loadConnectorConfig(home, {})).toThrow(/not valid JSON/)

    expect(() => normalizeConnectorConfig({ enabled: 'yes' })).toThrow(/enabled must be a boolean/)
    expect(() => normalizeConnectorConfig({ surprise: true })).toThrow(/unknown key surprise/)
    expect(() => normalizeConnectorConfig({ google: { services: ['slack'] } })).toThrow(/unsupported service/)
    expect(() => normalizeConnectorConfig({ google: { services: ['gmail', 'gmail'] } })).toThrow(/duplicate/)
    expect(() => normalizeConnectorConfig({ poll: { intervalMinutes: 1 } })).toThrow(/intervalMinutes/)
    expect(() => normalizeConnectorConfig({ poll: { maxRecordsPerPoll: 0 } })).toThrow(/maxRecordsPerPoll/)
    expect(() => normalizeConnectorConfig({ index: { maxRecords: -1 } })).toThrow(/maxRecords/)
    expect(() => normalizeConnectorConfig({ wake: { source: 'slack' } })).toThrow(/wake.source/)
    expect(() => normalizeConnectorConfig({ wake: { enabled: true } })).toThrow(/requires the top-level enabled/)
  })

  it('requires wake services to be a subset of polled services', () => {
    expect(() => normalizeConnectorConfig({
      enabled: true,
      google: { services: ['gmail'] },
      wake: { enabled: true, services: ['calendar'] },
    })).toThrow(/subset of google.services/)
  })

  it('accepts the seven public Workspace names and deterministic defaults', () => {
    const config = normalizeConnectorConfig({
      enabled: true,
      google: { services: [...GOOGLE_SERVICES] },
      poll: { intervalMinutes: 30, maxRecordsPerPoll: 10 },
      index: { maxRecords: 100, maxAgeDays: 30 },
      wake: {
        enabled: true,
        services: ['gmail', 'calendar', 'docs'],
        source: 'imessage',
        thread: 'chat-1',
        minIntervalMinutes: 60,
        maxPerDay: 1,
      },
    })
    expect(config.google.services).toEqual([...GOOGLE_SERVICES])
    expect(config.poll).toEqual({ intervalMinutes: 30, maxRecordsPerPoll: 10 })
    expect(config.index).toEqual({ maxRecords: 100, maxAgeDays: 30 })
    expect(config.wake).toMatchObject({
      enabled: true,
      services: ['gmail', 'calendar', 'docs'],
      source: 'imessage',
      thread: 'chat-1',
      minIntervalMinutes: 60,
      maxPerDay: 1,
      lookbackMinutes: 120,
      calendarLookaheadMinutes: 120,
    })
  })

  it('does not read credentials for a disabled config', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'broken-credentials.json'), 'not json')
    expect(resolveGoogleCredentials(normalizeConnectorConfig({}), home, {})).toBeUndefined()
    expect(resolveGoogleCredentials(
      normalizeConnectorConfig({ enabled: false, google: { credentialsFile: 'broken-credentials.json' } }),
      home,
      {},
    )).toBeUndefined()
  })

  it('fails loudly when enabled without credentials', () => {
    expect(() => resolveGoogleCredentials(
      normalizeConnectorConfig({ enabled: true }),
      tempHome(),
      {},
    )).toThrow(/GOOGLE_WORKSPACE_CREDENTIALS is not set/)
  })

  it('reads credentials from the configured environment variable', () => {
    const credentialsJson = JSON.stringify(credentials)
    const resolved = resolveGoogleCredentials(
      normalizeConnectorConfig({ enabled: true }),
      tempHome(),
      { GOOGLE_WORKSPACE_CREDENTIALS: credentialsJson },
    )
    expect(resolved).toEqual(credentials)
  })

  it('reads credentials from a relative file', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'google-credentials.json'), JSON.stringify(credentials))
    const resolved = resolveGoogleCredentials(
      normalizeConnectorConfig({
        enabled: true,
        google: { credentialsFile: 'google-credentials.json' },
      }),
      home,
      {},
    )
    expect(resolved).toEqual(credentials)
  })

  it('rejects ambiguous credential sources and malformed credential JSON', () => {
    expect(() => normalizeConnectorConfig({
      enabled: true,
      google: {
        credentialsEnv: 'GOOGLE_WORKSPACE_CREDENTIALS',
        credentialsFile: 'credentials.json',
      },
    })).toThrow(/exactly one of credentialsEnv or credentialsFile/)

    expect(() => parseGoogleCredentials('{', 'test')).toThrow(/not valid JSON/)
    expect(() => parseGoogleCredentials(JSON.stringify({ clientId: 'x' }), 'test')).toThrow(/clientSecret/)
    expect(() => parseGoogleCredentials(JSON.stringify({
      ...credentials,
      extra: 'nope',
    }), 'test')).toThrow(/unknown key/)
  })

  it('never includes a credential value in its error message', () => {
    const secret = 'super-secret-refresh-value'
    try {
      parseGoogleCredentials(JSON.stringify({ clientId: 'id', clientSecret: 'secret', refreshToken: '' }), 'test')
      throw new Error('expected parse to fail')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain(secret)
      expect(message).toContain('refreshToken')
    }
  })

  it('does not quote malformed credential JSON or unknown field names', () => {
    const secret = 'synthetic-oauth-secret-sentinel'
    for (const invalid of [secret, JSON.stringify({ [secret]: 'value' })]) {
      try {
        parseGoogleCredentials(invalid, 'test')
        throw new Error('expected parse to fail')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).not.toContain(secret)
      }
    }
  })
})
