import fs from 'node:fs'
import path from 'node:path'
import { FeishuClient, FeishuOutboxAdapter, FeishuSource, feishuConfigFromEnv } from '../../channels/feishu.ts'
import { demoLogDir, messageOf, sleep } from './lib.ts'

/**
 * Real Feishu smoke test. It is skipped by the GitHub-only acceptance path when
 * FEISHU_APP_ID/SECRET are absent, but it exercises the production adapter
 * whenever credentials exist:
 *
 *   1. send a bot message into FEISHU_CHAT_ID through the message API
 *   2. poll it back through the message-list Source and map it to a Trigger
 *   3. send a reply through the outbox adapter and confirm a message id
 *
 * A human-driven IM dialog demo can use the same Source/Outbox pair; the bot
 * cannot impersonate a human sender, so the three acceptance scenarios use the
 * GitHub issue thread as their real channel.
 */

async function main(): Promise<void> {
  const logDir = demoLogDir()
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, '04-feishu-smoke.log')
  const lines: string[] = []
  const log = (line: string) => {
    lines.push(line)
    console.log(line)
  }

  const config = feishuConfigFromEnv()
  if (!config?.chatId) {
    const message = config
      ? 'Feishu smoke needs FEISHU_CHAT_ID (the bot must be a member of that chat).'
      : 'Feishu smoke skipped: FEISHU_APP_ID and FEISHU_APP_SECRET are not set. '
        + 'See docs/REAL_CHANNELS.md; the three acceptance demos use real GitHub issues/comments.'
    fs.writeFileSync(logFile, `${lines.join('\n')}\n${message}\n`)
    throw new Error(message)
  }

  const runId = `feishu-${Date.now().toString(36)}`
  const client = new FeishuClient(config)
  const source = new FeishuSource(client, config.chatId, { sinceMs: Date.now() - 60_000, config })
  try {
    log(`[feishu] base=${config.baseUrl} chat=${config.chatId} runId=${runId}`)
    const sent = await client.sendText(config.chatId, `ds-agent smoke ${runId}`)
    log(`[feishu] sent message_id=${sent.message_id}`)
    await sleep(750)
    const triggers = await source.pull()
    const own = triggers.find(trigger => trigger.id === `feishu_${sent.message_id}`)
    if (!own) throw new Error(`sent message ${sent.message_id} was not visible through the Source poll`)
    log(`[feishu] source trigger id=${own.id} thread=${own.threads[0]?.id} human=${own.human} text=${JSON.stringify(own.text)}`)

    const adapter = new FeishuOutboxAdapter(client, log)
    const reply = await adapter.send({
      id: 'outbox_smoke',
      replyId: 'reply_smoke',
      ticketId: 'ticket_smoke',
      channel: 'im',
      thread: own.threads[0]?.id ?? '',
      target: own.channel?.address ?? {},
      text: `ds-agent reply smoke ${runId}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    log(`[feishu] outbox reply message_id=${reply.externalId}`)
    await sleep(750)
    const after = await source.pull()
    const roundTrip = after.find(trigger => trigger.id === `feishu_${reply.externalId}`)
    if (!roundTrip) throw new Error(`reply ${reply.externalId} was not visible through the Source poll`)
    log(`[feishu] round-trip ok trigger=${roundTrip.id}`)
    log('[feishu] smoke ok')
  } catch (error) {
    log(`[feishu] smoke failed: ${messageOf(error)}`)
    throw error
  } finally {
    fs.writeFileSync(logFile, `${lines.join('\n')}\n`)
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
