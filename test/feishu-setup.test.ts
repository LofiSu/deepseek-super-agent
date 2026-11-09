import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  evaluateFeishuBind,
  feishuBindMessageFromEvent,
  generateBindPassphrase,
} from '../src/cli/feishu-setup/bind.ts'
import {
  defaultFeishuCredentialsPath,
  writeFeishuEnvFile,
  type FeishuCredentialRecord,
} from '../src/cli/feishu-setup/credentials.ts'
import { runFeishuBindSession } from '../src/cli/feishu-setup/index.ts'
import { FeishuMockWsListener } from '../src/cli/feishu-setup/ws.ts'

const dirs: string[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-feishu-setup-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function p2pEvent(text: string, actor = 'ou_xxxxxxxx', chat = 'oc_xxxxxxxx'): unknown {
  return {
    event: {
      sender: {
        sender_type: 'user',
        sender_id: { open_id: actor },
      },
      message: {
        chat_id: chat,
        chat_type: 'p2p',
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    },
  }
}

describe('feishu setup bind logic', () => {
  it('generates stable-length bind passphrases', () => {
    const a = generateBindPassphrase()
    const b = generateBindPassphrase()
    expect(a).toMatch(/^BIND-/)
    expect(a).not.toBe(b)
  })

  it('accepts exact passphrase from p2p user', () => {
    const phrase = 'BIND-TEST123'
    const view = feishuBindMessageFromEvent(p2pEvent(phrase))!
    expect(evaluateFeishuBind(view, phrase)).toBe('accept')
  })

  it('rejects stranger/wrong passphrase in p2p', () => {
    const view = feishuBindMessageFromEvent(p2pEvent('wrong'))!
    expect(evaluateFeishuBind(view, 'BIND-EXPECTED')).toBe('reject-passphrase')
  })

  it('rejects group chat bind attempts', () => {
    const payload = p2pEvent('BIND-OK')
    const event = (payload as { event: Record<string, unknown> }).event
    const message = event.message as Record<string, unknown>
    message.chat_type = 'group'
    const view = feishuBindMessageFromEvent(payload)!
    expect(evaluateFeishuBind(view, 'BIND-OK')).toBe('reject-not-p2p')
  })
})

describe('feishu setup credentials file', () => {
  it('writes feishu.env with mode 0600 on unix', () => {
    if (process.platform === 'win32') return
    const home = tempHome()
    const file = defaultFeishuCredentialsPath(home)
    const record: FeishuCredentialRecord = {
      appId: 'cli_xxxxxxxx',
      appSecret: 'secret_placeholder',
      baseUrl: 'https://open.feishu.cn',
      chatId: 'oc_xxxxxxxx',
      actorAllowlist: 'ou_xxxxxxxx',
      dropSelf: 'ou_yyyyyyyy',
      p2pDirect: true,
    }
    writeFeishuEnvFile(file, record)
    const mode = fs.statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('FEISHU_APP_ID=cli_xxxxxxxx')
    expect(text).toContain('DS_AGENT_FEISHU_P2P_DIRECT=1')
    expect(text).toContain('FEISHU_APP_SECRET=secret_placeholder')
  })
})

describe('runFeishuBindSession', () => {
  it('completes bind when mock ws emits matching p2p message', async () => {
    const mock = new FeishuMockWsListener()
    const passphrase = 'BIND-MOCK01'
    const promise = runFeishuBindSession({
      passphrase,
      timeoutMs: 5_000,
      createListener: () => mock,
      botOpenId: 'ou_botxxxxxxxx',
    })
    await Promise.resolve()
    mock.emit(p2pEvent(passphrase, 'ou_userxxxxxxxx', 'oc_chatxxxxxxxx'))
    const result = await promise
    expect(result).toEqual({ chatId: 'oc_chatxxxxxxxx', actorOpenId: 'ou_userxxxxxxxx' })
  })

  it('stops listener on cancel/abort without resolving', async () => {
    const mock = new FeishuMockWsListener()
    const abort = new AbortController()
    const promise = runFeishuBindSession({
      passphrase: 'BIND-X',
      timeoutMs: 30_000,
      signal: abort.signal,
      createListener: () => mock,
    })
    await Promise.resolve()
    abort.abort()
    await expect(promise).rejects.toThrow(/bind cancelled/)
  })
})

describe('feishu setup dry-run CLI', () => {
  it('exits 0 without creating credentials file', async () => {
    const home = tempHome()
    const cred = defaultFeishuCredentialsPath(home)
    const repoRoot = path.resolve(import.meta.dirname, '..')
    const result = spawnSync(
      'pnpm',
      ['ds-agent', 'feishu', 'setup', '--dry-run'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DS_AGENT_HOME: home,
          FEISHU_APP_ID: 'cli_xxxxxxxx',
          FEISHU_APP_SECRET: 'placeholder_secret',
        },
        encoding: 'utf8',
      },
    )
    expect(result.status).toBe(0)
    expect(fs.existsSync(cred)).toBe(false)
    expect(result.stdout).toContain('[dry-run]')
  })
})
