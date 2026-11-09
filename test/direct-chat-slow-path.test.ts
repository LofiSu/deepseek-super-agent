import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { feishuTriggerFromMessage, type FeishuConfig } from '../src/channels/feishu.ts'
import { imTrigger } from '../src/channels/im.ts'
import { MockModel } from '../src/harness/model.ts'
import { ruleClassify, type SemanticHit } from '../src/ingress/filter.ts'
import { filterTriggerWithPolicy, PolicyClassifier, type SemanticPolicy } from '../src/ingress/policy.ts'
import { Runtime, type SlowPathOptions } from '../src/runtime.ts'
import type { Trigger } from '../src/shared/types.ts'

const feishuConfig: FeishuConfig = {
  appId: 'cli_app',
  appSecret: 'secret',
  baseUrl: 'https://open.feishu.cn',
  botOpenId: 'ou_bot',
}

const admission = {
  actors: ['ou_human'],
  dropSelf: ['ou_bot_self'],
}

function greetingDropPolicy(): { policy: SemanticPolicy; calls: Trigger[] } {
  const calls: Trigger[] = []
  const hit: SemanticHit = {
    pass: false,
    strength: 'inferred',
    reason: 'Greeting only, no request or implied action for the assistant.',
  }
  return {
    calls,
    policy: {
      name: 'GreetingDropPolicy',
      async classifyPolicy(trigger: Trigger): Promise<SemanticHit> {
        calls.push(trigger)
        return hit
      },
    },
  }
}

function feishuP2pGreeting(text: string, actor = 'ou_human'): Trigger {
  const prev = process.env.DS_AGENT_FEISHU_P2P_DIRECT
  process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
  try {
    return feishuTriggerFromMessage({
      message_id: `om_${text}`,
      chat_id: 'oc_p2p',
      msg_type: 'text',
      body: { content: JSON.stringify({ text }) },
      create_time: '1761958800000',
      sender: { id: actor, sender_type: 'user' },
    }, feishuConfig)
  } finally {
    if (prev === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
    else process.env.DS_AGENT_FEISHU_P2P_DIRECT = prev
  }
}

const runtimes: Runtime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.daemon.stop()
    if (runtime.store.isOpen) runtime.store.close()
  }
  vi.unstubAllGlobals()
})

function makeRuntime(slowPath: SlowPathOptions, env: NodeJS.ProcessEnv = {}): Runtime {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-direct-chat-'))
  const runtime = Runtime.create({
    home,
    model: new MockModel(),
    slowPath,
    admission,
    env,
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    batchWindowMs: 60_000,
  })
  runtimes.push(runtime)
  return runtime
}

describe('direct chat with model slow path', () => {
  it('passes allowlisted p2p greetings via rules, not a dropping model policy', async () => {
    const { policy, calls } = greetingDropPolicy()
    const runtime = makeRuntime({ mode: 'model', policy })
    const hi = feishuP2pGreeting('你好')
    const hi2 = feishuP2pGreeting('你好啊')
    const en = feishuP2pGreeting('hi')

    for (const trigger of [hi, hi2, en]) {
      expect(ruleClassify(trigger).pass).toBe(true)
      expect(await runtime.ingestAsync(trigger)).toBe('stored')
    }
    expect(calls).toHaveLength(0)
  })

  it('passes a normal request from an allowlisted direct user', async () => {
    const { policy, calls } = greetingDropPolicy()
    const runtime = makeRuntime({ mode: 'model', policy })
    const trigger = feishuP2pGreeting('please fix the login timeout')
    expect(await runtime.ingestAsync(trigger)).toBe('stored')
    expect(calls).toHaveLength(0)
  })

  it('drops bot/self and non-allowlisted actors on the fast path', async () => {
    const { policy, calls } = greetingDropPolicy()
    const runtime = makeRuntime({ mode: 'model', policy })

    expect(await runtime.ingestAsync(feishuP2pGreeting('bot-self', 'ou_bot_self'))).toBe('filtered')
    expect(await runtime.ingestAsync(feishuP2pGreeting('stranger', 'cli_example_other_app'))).toBe('filtered')
    expect(calls).toHaveLength(0)
  })

  it('still drops group chatter without a mention via fast path', async () => {
    const prev = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
    try {
      const { policy, calls } = greetingDropPolicy()
      const runtime = makeRuntime({ mode: 'model', policy })
      const trigger = feishuTriggerFromMessage({
        message_id: 'om_grp',
        chat_id: 'oc_group',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: 'random lunch chat' }) },
        create_time: '1761958800000',
        sender: { id: 'ou_human', sender_type: 'user' },
      }, feishuConfig)
      expect(trigger.addressed).toBeUndefined()
      expect(await runtime.ingestAsync(trigger)).toBe('filtered')
      expect(calls).toHaveLength(0)
    } finally {
      if (prev !== undefined) process.env.DS_AGENT_FEISHU_P2P_DIRECT = prev
    }
  })

  it('filterTriggerWithPolicy admits direct iMessage-style hellos while model would drop', async () => {
    const { policy, calls } = greetingDropPolicy()
    const direct = {
      ...imTrigger({ id: 'dm-hello', thread: 'chat/+1', text: '你好', actor: 'ou_human' }),
      addressed: 'direct' as const,
      channel: {
        source: 'imessage' as const,
        thread: 'chat:any;-;+1',
        address: { handle: '+1' },
      },
    }
    const verdict = await filterTriggerWithPolicy(direct, new MockModel(), admission, undefined)
    // No policy wired — rules pass
    expect(verdict).toMatchObject({ action: 'pass', reason: 'explicit' })

    const withPolicy = await filterTriggerWithPolicy(
      direct,
      new MockModel(),
      admission,
      new PolicyClassifier(policy),
    )
    expect(withPolicy).toMatchObject({ action: 'pass', reason: 'explicit' })
    expect(calls).toHaveLength(0)
  })
})

