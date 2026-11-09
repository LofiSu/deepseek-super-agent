import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { feishuTriggerFromMessage, type FeishuConfig } from '../src/channels/feishu.ts'
import { MockModel } from '../src/harness/model.ts'
import type { Disposition, Thread } from '../src/shared/types.ts'
import { Runtime, type SlowPathOptions } from '../src/runtime.ts'
import { ScriptedModel } from './scripted-model.ts'

const feishuConfig: FeishuConfig = {
  appId: 'cli_app',
  appSecret: 'secret',
  baseUrl: 'https://open.feishu.cn',
  botOpenId: 'ou_bot',
}

const admission = { actors: ['ou_human'], dropSelf: ['ou_bot_self'], groups: [] as string[] }

const runtimes: Runtime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.daemon.stop()
    if (runtime.store.isOpen) runtime.store.close()
  }
})

function feishuP2p(input: { message_id: string; msg_type: string; content: object; text?: string }): ReturnType<typeof feishuTriggerFromMessage> {
  const prev = process.env.DS_AGENT_FEISHU_P2P_DIRECT
  process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
  try {
    return feishuTriggerFromMessage({
      message_id: input.message_id,
      chat_id: 'oc_p2p',
      msg_type: input.msg_type,
      body: { content: JSON.stringify(input.content) },
      create_time: '1761958800000',
      sender: { id: 'ou_human', sender_type: 'user' },
    }, feishuConfig)
  } finally {
    if (prev === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
    else process.env.DS_AGENT_FEISHU_P2P_DIRECT = prev
  }
}

function makeRuntime(model: MockModel | ScriptedModel, slowPath?: SlowPathOptions): Runtime {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-feishu-media-'))
  const runtime = Runtime.create({
    home,
    model,
    slowPath,
    admission,
    env: {
      ...process.env,
      DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
      DS_AGENT_ACTOR_ALLOWLIST: 'ou_human',
      DS_AGENT_DROP_SELF: 'ou_bot_self',
      DS_AGENT_GROUP_ALLOWLIST: '',
    },
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    batchWindowMs: 60_000,
  })
  runtimes.push(runtime)
  return runtime
}

describe('Feishu p2p media + acknowledgement', () => {
  it('does not enqueue an English acknowledgement when Eval accepts a direct media trigger', async () => {
    const accept = new ScriptedModel(request => {
      if (request.role !== 'router') return { text: 'worker-idle' }
      return {
        text: JSON.stringify({
          kind: 'accept',
          reason: 'media',
          title: '[file]',
          scope: 'explain that attachments cannot be read yet',
        }),
      }
    })
    const runtime = makeRuntime(accept)
    const media = feishuP2p({
      message_id: 'om_file',
      msg_type: 'text',
      content: { file_key: 'v3_test_file' },
    })
    expect(media.text).toBe('[file]')
    expect(await runtime.ingestAsync(media)).toBe('stored')
    runtime.engine.evaluateDue()
    const acks = runtime.store.listReplies().filter(reply => reply.purpose === 'acknowledgement')
    expect(acks).toHaveLength(0)
    expect(runtime.log.text()).not.toMatch(/Acknowledged.*Working on it/)
  })

  it('routes a direct 你好 through Eval instead of bypassing an open media ticket', async () => {
    const accept = new ScriptedModel(request => {
      if (request.role !== 'router') return { text: 'worker-idle' }
      return {
        text: JSON.stringify({
          kind: 'accept',
          reason: 'media',
          title: '[file]',
          scope: 'explain that attachments cannot be read yet',
        }),
      }
    })
    const runtime = makeRuntime(accept)
    const media = feishuP2p({
      message_id: 'om_file',
      msg_type: 'text',
      content: { file_key: 'v3_test_file' },
    })
    expect(await runtime.ingestAsync(media)).toBe('stored')
    runtime.engine.evaluateDue()
    const hello = feishuP2p({ message_id: 'om_hi', msg_type: 'text', content: { text: '你好' } })
    expect(await runtime.ingestAsync(hello)).toBe('stored')
    const disposition = runtime.store.getDoc<Disposition>("disposition", "feishu_om_hi")
    expect(disposition?.fanout ?? []).toEqual([])
    expect(runtime.log.text()).not.toContain('bypass=subscription')
    const thread = runtime.store.getDoc<Thread>("thread", "im:feishu:oc_p2p")
    expect(thread?.pending).toContain('feishu_om_hi')
  })

  it('still drops bot self and non-allowlisted strangers', async () => {
    const runtime = makeRuntime(new MockModel())
    const stranger = feishuP2p({ message_id: 'om_stranger', msg_type: 'text', content: { text: '你好' } })
    stranger.actor = { source: 'im', id: 'cli_example_other_app' }
    expect(await runtime.ingestAsync(stranger)).toBe('filtered')
    const self = feishuP2p({ message_id: 'om_self', msg_type: 'text', content: { text: 'pong' } })
    self.actor = { source: 'im', id: 'ou_bot_self' }
    expect(await runtime.ingestAsync(self)).toBe('filtered')
  })
})
