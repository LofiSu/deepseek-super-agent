import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IMESSAGE_ADMISSION_ERROR,
  ImessageSource,
  type ImessageApi,
} from '../src/channels/imessage.ts'
import {
  checkFeishuChannel,
  checkImessageChannel,
  resolveServeChannelConfigs,
  runChannelsCheck,
  startServeChannels,
} from '../src/cli/channels.ts'
import { runImessageLoop } from '../src/cli/channel-loop.ts'
import { MockModel } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'

const dirs: string[] = []
const runtimes: Runtime[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function chatDb(dir: string, text = 'TOP SECRET message body'): string {
  const dbPath = path.join(dir, 'chat.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT,
      style INTEGER, room_name TEXT
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
    );
    CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
  `)
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+15550000000')
  db.prepare(
    'INSERT INTO chat (ROWID, guid, chat_identifier, style) VALUES (1, ?, ?, 45)',
  ).run('iMessage;-;+15550000000', '+15550000000')
  db.prepare(
    `INSERT INTO message
      (ROWID, guid, text, attributedBody, date, service, handle_id, is_from_me)
     VALUES (1, 'G1', ?, NULL, 0, 'iMessage', 1, 0)`,
  ).run(text)
  db.prepare('INSERT INTO chat_message_join (message_id, chat_id) VALUES (1, 1)').run()
  db.close()
  return dbPath
}

function runtime(home = tempDir('ds-agent-channels-home-')): Runtime {
  const created = Runtime.create({
    home,
    model: new MockModel(),
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    env: { ...process.env, DS_AGENT_GROUP_ALLOWLIST: 'oc_check' },
  })
  created.start()
  runtimes.push(created)
  return created
}

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...overrides,
  }
}

function bothConfigs(dbPath: string) {
  return resolveServeChannelConfigs(
    [
      'node', 'ds-agent', 'serve', '--imessage', '--feishu',
      '--handle', '+15550000000', '--db', dbPath, '--chat', 'oc_check', '--since', '1',
    ],
    baseEnv({
      FEISHU_APP_ID: 'app',
      FEISHU_APP_SECRET: 'app-secret-value',
      FEISHU_CHAT_ID: 'oc_env',
    }),
  )
}

afterEach(async () => {
  for (const created of runtimes.splice(0)) {
    if (created.store.isOpen) {
      created.daemon.stop()
      await created.finish().catch(() => undefined)
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('combined serve channels', () => {
  it('resolves both configurations and keeps independent failure isolation', async () => {
    const dir = tempDir('ds-agent-channels-both-')
    const configs = bothConfigs(path.join(dir, 'chat.db'))
    expect(configs.imessage?.handle).toBe('+15550000000')
    expect(configs.feishu?.chatId).toBe('oc_check')

    const rt = runtime()
    const closed: string[] = []
    let imessageStarted = false
    let feishuStarted = false
    let feishuAborted = false
    const api: ImessageApi & { close(): void } = {
      async pull() { return [] },
      async maxRowId() { return 0 },
      async send() { return { externalId: 'unused' } },
      close() { closed.push('imessage-close') },
    }

    const started = startServeChannels({
      runtime: rt,
      imessage: configs.imessage!,
      feishu: configs.feishu!,
      createImessageApi: () => api,
      runImessage: async () => {
        imessageStarted = true
        throw new Error('imessage boom')
      },
      runFeishu: async ({ signal }) => {
        feishuStarted = true
        await new Promise<void>(resolve => {
          if (signal?.aborted) {
            feishuAborted = true
            resolve()
            return
          }
          signal?.addEventListener('abort', () => {
            feishuAborted = true
            resolve()
          }, { once: true })
        })
      },
    })

    await waitFor(() => imessageStarted && feishuStarted)
    await waitFor(() => rt.log.text().includes('[imessage] loop stopped error=imessage boom'))
    // The failed loop did not kill the other loop or close the shared store.
    expect(feishuAborted).toBe(false)
    expect(rt.store.isOpen).toBe(true)
    expect(closed).toEqual([])

    started.abort()
    await withTimeout(started.wait())
    started.close()
    expect(feishuAborted).toBe(true)
    expect(closed).toEqual(['imessage-close'])
    expect(rt.store.isOpen).toBe(true)
  })

  it('fails closed before Runtime/SQLite when either combined config is missing', () => {
    expect(() => resolveServeChannelConfigs(
      ['node', 'ds-agent', 'serve', '--imessage', '--feishu', '--chat', 'oc_check'],
      baseEnv(),
    )).toThrow(/cannot start both inbound channels[\s\S]*iMessage:[\s\S]*Feishu:/)

    expect(() => resolveServeChannelConfigs(
      ['node', 'ds-agent', 'serve', '--imessage', '--feishu', '--handle', '+15550000000'],
      baseEnv({
        FEISHU_APP_ID: 'app',
        FEISHU_APP_SECRET: 'secret',
      }),
    )).toThrow(/cannot start both inbound channels[\s\S]*Feishu:[\s\S]*FEISHU_CHAT_ID/)

    // A single missing channel keeps the historical, focused error text.
    expect(() => resolveServeChannelConfigs(
      ['node', 'ds-agent', 'serve', '--imessage'],
      baseEnv(),
    )).toThrow(IMESSAGE_ADMISSION_ERROR)
  })
})

describe('channels check preflight', () => {
  it('reports iMessage metadata, admission, and the manual Automation command without message text', () => {
    const dir = tempDir('ds-agent-check-imessage-')
    const dbPath = chatDb(dir)
    const result = checkImessageChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--imessage', '--db', dbPath],
      env: baseEnv({ DS_AGENT_IMESSAGE_HANDLE: '+15550000000' }),
      findExecutable: () => '/usr/bin/osascript',
    })
    const output = result.lines.join('\n')
    expect(result.ready).toBe(true)
    expect(output).toContain('[imessage] schema: ok')
    expect(output).toContain('count=1 latest_rowid=1')
    expect(output).toContain('admission: allowed handle=+15550000000')
    expect(output).toContain('osascript: found')
    expect(output).toContain('tell application "Messages" to get name')
    expect(output).toContain('System Settings > Privacy & Security > Automation')
    expect(output).not.toContain('TOP SECRET message body')
  })

  it('maps a TCC denial to Full Disk Access guidance and never reports ready', () => {
    const dir = tempDir('ds-agent-check-imessage-tcc-')
    const dbPath = path.join(dir, 'chat.db')
    fs.writeFileSync(dbPath, '')
    const result = checkImessageChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--imessage', '--db', dbPath],
      env: baseEnv({ DS_AGENT_IMESSAGE_HANDLE: '+15550000000' }),
      findExecutable: () => '/usr/bin/osascript',
      openDatabase: () => { throw new Error('authorization denied') },
    })
    const output = result.lines.join('\n')
    expect(result.ready).toBe(false)
    expect(output).toContain('permission denied')
    expect(output).toContain('Grant Full Disk Access to your terminal')
    expect(output).toContain('System Settings > Privacy & Security > Full Disk Access')
    expect(output).toContain('[imessage] NOT READY')
  })

  it('reports missing Feishu credentials without going online', async () => {
    let fetched = false
    const result = await checkFeishuChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu', '--chat', 'oc_check'],
      env: baseEnv(),
      fetchImpl: async () => {
        fetched = true
        throw new Error('network must stay off')
      },
    })
    const output = result.lines.join('\n')
    expect(result.ready).toBe(false)
    expect(fetched).toBe(false)
    expect(output).toContain('FEISHU_APP_ID')
    expect(output).toContain('FEISHU_APP_SECRET')
    expect(output).toContain('network: skipped')
  })

  it('reports a ready offline Feishu config without printing the app secret', async () => {
    let fetched = false
    const result = await checkFeishuChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu', '--chat', 'oc_check'],
      env: baseEnv({
        FEISHU_APP_ID: 'app',
        FEISHU_APP_SECRET: 'app-secret-value',
        FEISHU_CHAT_ID: 'oc_env',
      }),
      fetchImpl: async () => {
        fetched = true
        throw new Error('network must stay off')
      },
    })
    const output = result.lines.join('\n')
    expect(result.ready).toBe(true)
    expect(fetched).toBe(false)
    expect(output).toContain('credentials: present')
    expect(output).toContain('chat: present (polling exactly one chat)')
    expect(output).toContain('base URL: https://open.feishu.cn')
    expect(output).toContain('network: skipped')
    expect(output).not.toContain('app-secret-value')
  })

  it('checks Feishu credentials with an injected network call and hides the token', async () => {
    let calls = 0
    const result = await checkFeishuChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu', '--chat', 'oc_check', '--network'],
      env: baseEnv({
        FEISHU_APP_ID: 'app',
        FEISHU_APP_SECRET: 'app-secret-value',
      }),
      network: true,
      fetchImpl: async () => {
        calls += 1
        return new Response(JSON.stringify({
          code: 0,
          tenant_access_token: 'token-value-must-not-print',
          expire: 7200,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })
    const output = result.lines.join('\n')
    expect(result.ready).toBe(true)
    expect(calls).toBe(1)
    expect(output).toContain('tenant_access_token: ok')
    expect(output).not.toContain('app-secret-value')
    expect(output).not.toContain('token-value-must-not-print')
  })

  it('exits non-zero when any selected channel is not ready', async () => {
    const dir = tempDir('ds-agent-check-code-')
    const dbPath = chatDb(dir)
    const ready = await runChannelsCheck({
      channels: ['imessage'],
      argv: ['node', 'ds-agent', 'channels', 'check', '--imessage', '--db', dbPath],
      env: baseEnv({ DS_AGENT_IMESSAGE_HANDLE: '+15550000000' }),
      findExecutable: () => '/usr/bin/osascript',
    })
    expect(ready.code).toBe(0)

    const notReady = await runChannelsCheck({
      channels: ['feishu'],
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu'],
      env: baseEnv(),
    })
    expect(notReady.code).toBe(1)
    expect(notReady.lines.join('\n')).toContain('NOT READY')
  })

  it('stops retrying a standalone iMessage loop after a permission denial', async () => {
    const rt = runtime()
    let pulls = 0
    const api: ImessageApi = {
      async pull() {
        pulls += 1
        throw new Error('authorization denied')
      },
      async maxRowId() { return 0 },
      async send() { return { externalId: 'unused' } },
    }
    await expect(runImessageLoop({
      runtime: rt,
      source: new ImessageSource(api),
      api,
      dbPath: 'unused-chat.db',
      intervalMs: 5,
      once: true,
    })).rejects.toThrow(/Full Disk Access/)
    expect(pulls).toBe(1)
  })
})

describe('channel docs and help', () => {
  it('documents combined serve and preflight, and help no longer forbids the pair', () => {
    const help = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', '--help'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DS_AGENT_HOME: tempDir('ds-agent-help-') } },
    )
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain('channels check')
    expect(help.stdout).toContain('[--imessage] [--feishu]')
    expect(help.stdout).toContain('independent cursors')
    expect(help.stdout).not.toContain('cannot be combined')

    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8')
    const realChannels = fs.readFileSync(path.join(process.cwd(), 'docs/REAL_CHANNELS.md'), 'utf8')
    const imessage = fs.readFileSync(path.join(process.cwd(), 'docs/IMESSAGE.md'), 'utf8')
    expect(readme).toContain('ds-agent channels check')
    expect(readme).toContain('serve --imessage --feishu')
    expect(realChannels).toContain('Inbound webhooks')
    expect(realChannels).toContain('long-connection')
    expect(imessage).toContain('Full Disk Access')
    expect(imessage).toContain('channels check')
  })
})
