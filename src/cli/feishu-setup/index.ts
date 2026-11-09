import fs from 'node:fs'
import { FeishuClient } from '../../channels/feishu.ts'
import {
  evaluateFeishuBind,
  feishuBindMessageFromEvent,
  generateBindPassphrase,
  type FeishuBindVerdict,
} from './bind.ts'
import {
  defaultFeishuCredentialsPath,
  promptLine,
  readFeishuEnvFileIfPresent,
  writeFeishuEnvFile,
  type FeishuCredentialRecord,
} from './credentials.ts'
import { FeishuSdkWsListener, type FeishuWsListener } from './ws.ts'

export const FEISHU_SETUP_HUMAN_STEPS = [
  'Log in to the Feishu/Lark developer console and create a custom app.',
  'Enable the Bot capability and add scopes: im:message.p2p_msg:readonly, im:message:send_as_bot (group apps may also need im:message:readonly / im:message.group_msg).',
  'Subscribe to event im.message.receive_v1 with delivery mode Long connection (outbound WebSocket).',
  'Publish an app version and complete tenant approval if required.',
  'Open a private chat with the bot (applink) so you can send the bind passphrase.',
] as const

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = process.argv[index + 1]?.trim()
  return value && !value.startsWith('--') ? value : undefined
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

export interface RunFeishuBindOptions {
  passphrase: string
  botOpenId?: string
  timeoutMs: number
  signal?: AbortSignal
  createListener: () => FeishuWsListener
  onStatus?: (line: string) => void
}

export interface RunFeishuBindResult {
  chatId: string
  actorOpenId: string
}

/**
 * Wait until a p2p sender posts the exact passphrase over the injectable listener.
 * Rejects strangers (wrong chat type / wrong text / bot messages).
 */
export async function runFeishuBindSession(
  options: RunFeishuBindOptions,
): Promise<RunFeishuBindResult> {
  const listener = options.createListener()
  let settled = false
  let failTimer: ReturnType<typeof setTimeout> | undefined
  const log = (line: string): void => options.onStatus?.(line)

  return await new Promise<RunFeishuBindResult>((resolve, reject) => {
    let onAbort: (() => void) | undefined

    const finish = (error?: Error, result?: RunFeishuBindResult): void => {
      if (settled) return
      settled = true
      if (failTimer) clearTimeout(failTimer)
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
      listener.stop()
      if (error) reject(error)
      else resolve(result!)
    }

    onAbort = (): void => {
      finish(new Error('bind cancelled'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    failTimer = setTimeout(() => {
      finish(new Error(`bind timed out after ${Math.round(options.timeoutMs / 1000)}s`))
    }, options.timeoutMs)

    const onEvent = (payload: unknown): void => {
      const view = feishuBindMessageFromEvent(payload)
      if (!view) return
      const verdict: FeishuBindVerdict = evaluateFeishuBind(view, options.passphrase, options.botOpenId)
      if (verdict === 'ignore') return
      if (verdict === 'accept' && view.chatId && view.senderOpenId) {
        log(`[feishu setup] bind ok chat=${view.chatId} actor=${view.senderOpenId}`)
        finish(undefined, { chatId: view.chatId, actorOpenId: view.senderOpenId })
        return
      }
      log(`[feishu setup] bind ignored (${verdict}) chat=${view.chatId ?? '-'} actor=${view.senderOpenId ?? '-'}`)
    }

    listener.start(onEvent).catch(error => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

export interface FeishuSetupOptions {
  home: string
  env?: NodeJS.ProcessEnv
  dryRun?: boolean
  credentialsPath?: string
  bindTimeoutMs?: number
  skipBind?: boolean
  forceBind?: boolean
  createListener?: (record: Pick<FeishuCredentialRecord, 'appId' | 'appSecret' | 'baseUrl'>) => FeishuWsListener
  fetchBotOpenId?: (record: FeishuCredentialRecord) => Promise<string | undefined>
}

function baseUrlFromEnv(env: NodeJS.ProcessEnv): string {
  return (env.FEISHU_BASE_URL?.trim() || 'https://open.feishu.cn').replace(/\/$/, '')
}

export function printFeishuSetupNextSteps(credentialsPath: string): void {
  const quoted = credentialsPath.includes(' ') ? JSON.stringify(credentialsPath) : credentialsPath
  console.log('\nNext steps (load credentials, then run the existing CLI paths):')
  console.log(`  set -a && source ${quoted} && set +a`)
  console.log('  pnpm ds-agent channels check --feishu --network')
  console.log('  export DS_AGENT_FEISHU_P2P_DIRECT=1   # usually already in feishu.env')
  console.log('  # configure a live model (DS_AGENT_API_BASE + DS_AGENT_API_KEY, or a provider key)')
  console.log('  pnpm ds-agent serve --feishu')
  console.log('\nLimitations: `serve --feishu` still uses one-chat HTTP polling for inbound; setup bind uses long connection only to pair your p2p chat. Media often arrives as opaque keys—the bot does not see image bytes unless you add tooling.')
}

export async function runFeishuSetupCommand(home: string): Promise<void> {
  const env = process.env
  const dryRun = has('dry-run')
  const skipBind = has('skip-bind')
  const forceBind = has('force-bind')
  const credentialsPath = flag('credentials') ?? defaultFeishuCredentialsPath(home)
  const bindTimeoutMs = Math.max(30_000, Number(flag('bind-timeout') ?? '600') * 1000 || 600_000)

  const previousUmask = process.umask(0o077)
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })

    console.log('Feishu quick setup (generic ds-agent).\n')
    console.log('You must complete these steps in the Feishu console (not automated):')
    for (const [index, step] of FEISHU_SETUP_HUMAN_STEPS.entries()) {
      console.log(`  ${index + 1}. ${step}`)
    }
    console.log('')

    const existing = readFeishuEnvFileIfPresent(credentialsPath)
    let appId = env.FEISHU_APP_ID?.trim() ?? existing?.appId
    let appSecret = env.FEISHU_APP_SECRET?.trim() ?? existing?.appSecret

    if (!appId) appId = await promptLine('Feishu App ID (cli_xxxxxxxx): ')
    if (!appSecret) appSecret = await promptLine('Feishu App Secret: ', true)
    if (!appId || !appSecret) {
      throw new Error('Feishu App ID and App Secret are required.')
    }

    const baseUrl = baseUrlFromEnv(env)
    const record: FeishuCredentialRecord = {
      appId,
      appSecret,
      baseUrl,
      p2pDirect: true,
    }

    if (dryRun) {
      console.log('[dry-run] would write credentials (mode 0600):')
      console.log(`  ${credentialsPath}`)
      console.log('[dry-run] would start outbound long-connection listener for p2p bind')
      console.log('[dry-run] would fetch bot open_id via /open-apis/bot/v3/info')
      printFeishuSetupNextSteps(credentialsPath)
      return
    }

    const alreadyBound = Boolean(existing?.chatId && existing?.actorAllowlist && !forceBind)
    if (skipBind || alreadyBound) {
      if (existing?.chatId) record.chatId = existing.chatId
      if (existing?.botOpenId) record.botOpenId = existing.botOpenId
      if (existing?.actorAllowlist) record.actorAllowlist = existing.actorAllowlist
      if (existing?.dropSelf) record.dropSelf = existing.dropSelf
      writeFeishuEnvFile(credentialsPath, record)
      console.log(`Credentials updated (bind skipped): ${credentialsPath}`)
      printFeishuSetupNextSteps(credentialsPath)
      return
    }

    const client = new FeishuClient({ appId, appSecret, baseUrl })
    let botOpenId: string | undefined
    try {
      botOpenId = await client.botOpenId()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`cannot load bot open_id (check scopes and published app version): ${message}`)
    }
    if (botOpenId) {
      record.botOpenId = botOpenId
      record.dropSelf = botOpenId
    }

    const passphrase = generateBindPassphrase()
    console.log('\nOpen the bot private chat and send this exact passphrase (copy/paste):')
    console.log(`  ${passphrase}`)
    console.log(`\nListening via Feishu long connection (outbound WebSocket only). Timeout: ${Math.round(bindTimeoutMs / 1000)}s.`)
    console.log('Press Ctrl+C to cancel without saving bind fields.\n')

    const abort = new AbortController()
    const onSigint = (): void => {
      abort.abort()
    }
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigint)

    const createListener = (): FeishuWsListener => new FeishuSdkWsListener({ appId, appSecret, baseUrl })

    let bind: RunFeishuBindResult
    try {
      bind = await runFeishuBindSession({
        passphrase,
        botOpenId,
        timeoutMs: bindTimeoutMs,
        signal: abort.signal,
        createListener,
        onStatus: line => console.log(line),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'bind cancelled' || abort.signal.aborted) {
        console.log('\nBind cancelled; credentials file was not updated with chat pairing.')
        return
      }
      throw error
    } finally {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigint)
    }

    record.chatId = bind.chatId
    record.actorAllowlist = bind.actorOpenId
    writeFeishuEnvFile(credentialsPath, record)

    console.log(`\nWrote ${credentialsPath} (mode 0600, directory 0700).`)
    printFeishuSetupNextSteps(credentialsPath)
  } finally {
    process.umask(previousUmask)
  }
}

export async function runFeishuSetupWithOptions(options: FeishuSetupOptions): Promise<void> {
  const env = options.env ?? process.env
  const credentialsPath = options.credentialsPath ?? defaultFeishuCredentialsPath(options.home)
  const record: FeishuCredentialRecord = {
    appId: env.FEISHU_APP_ID?.trim() ?? 'cli_xxxxxxxx',
    appSecret: env.FEISHU_APP_SECRET?.trim() ?? 'placeholder',
    baseUrl: baseUrlFromEnv(env),
    p2pDirect: true,
  }
  if (options.dryRun) return
  const fetchBot = options.fetchBotOpenId ?? (async inner => {
    const client = new FeishuClient({
      appId: inner.appId,
      appSecret: inner.appSecret,
      baseUrl: inner.baseUrl,
    })
    return client.botOpenId()
  })
  if (options.skipBind) {
    writeFeishuEnvFile(credentialsPath, record)
    return
  }
  const botOpenId = await fetchBot(record)
  if (botOpenId) {
    record.botOpenId = botOpenId
    record.dropSelf = botOpenId
  }
  const passphrase = generateBindPassphrase()
  const createListener = options.createListener
    ? () => options.createListener!({
      appId: record.appId,
      appSecret: record.appSecret,
      baseUrl: record.baseUrl,
    })
    : () => new FeishuSdkWsListener({ appId: record.appId, appSecret: record.appSecret, baseUrl: record.baseUrl })
  const bind = await runFeishuBindSession({
    passphrase,
    botOpenId,
    timeoutMs: options.bindTimeoutMs ?? 60_000,
    createListener,
  })
  record.chatId = bind.chatId
  record.actorAllowlist = bind.actorOpenId
  writeFeishuEnvFile(credentialsPath, record)
}
