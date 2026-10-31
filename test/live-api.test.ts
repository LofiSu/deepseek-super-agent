import { describe, expect, it } from 'vitest'
import { demoModel } from '../src/cli/demo.ts'
import { createModelFromEnv, HttpOpenAI, requireLiveModelFromEnv } from '../src/harness/model.ts'
import { PROVIDER_PRESETS, resolveLiveApi } from '../src/harness/providers.ts'

const PRESET_ROWS = [
  { key: 'DEEPSEEK_API_KEY', provider: 'deepseek', base: 'https://api.deepseek.com', model: 'deepseek-flash' },
  { key: 'OPENAI_API_KEY', provider: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { key: 'OPENROUTER_API_KEY', provider: 'openrouter', base: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
  { key: 'XAI_API_KEY', provider: 'xai', base: 'https://api.x.ai/v1', model: 'grok-4.7' },
  { key: 'GROK_API_KEY', provider: 'xai', base: 'https://api.x.ai/v1', model: 'grok-4.7' },
  { key: 'MOONSHOT_API_KEY', provider: 'moonshot', base: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro' },
  { key: 'KIMI_API_KEY', provider: 'moonshot', base: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro' },
  { key: 'ZHIPU_API_KEY', provider: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
  { key: 'GLM_API_KEY', provider: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
  { key: 'GEMINI_API_KEY', provider: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  { key: 'GOOGLE_API_KEY', provider: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  { key: 'ANTHROPIC_API_KEY', provider: 'anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5' },
] as const

describe('resolveLiveApi', () => {
  it('returns null when no provider is configured and does not read process.env', () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'from-process'
    try {
      expect(resolveLiveApi({})).toBeNull()
      expect(createModelFromEnv({}).name).toBe('MockModel')
      expect(() => demoModel({})).toThrow(/MockModel is forbidden|requires a live model/)
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  it('treats blank values as unset', () => {
    expect(resolveLiveApi({
      OPENAI_API_KEY: '   ',
      DS_AGENT_API_BASE: '',
      DS_AGENT_API_KEY: '\n',
      DS_AGENT_PROVIDER: '  ',
    })).toBeNull()
  })

  it('keeps the explicit base/key pair on HttpOpenAI with the deepseek-chat default', () => {
    const live = resolveLiveApi({
      DS_AGENT_API_BASE: 'http://127.0.0.1:9/v1',
      DS_AGENT_API_KEY: 'test-key',
      OPENAI_API_KEY: 'other',
      DS_AGENT_PROVIDER: 'openai',
    })
    expect(live).toEqual({
      provider: 'custom',
      base: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key',
      model: 'deepseek-chat',
    })
    expect(createModelFromEnv({
      DS_AGENT_API_BASE: 'http://127.0.0.1:9/v1',
      DS_AGENT_API_KEY: 'test-key',
    })).toBeInstanceOf(HttpOpenAI)
    const required = requireLiveModelFromEnv({
      DS_AGENT_API_BASE: 'https://api.openai.com/v1',
      DS_AGENT_API_KEY: 'test-key',
    })
    expect(required.name).toBe('HttpOpenAI')
  })

  it('prefers DS_AGENT_API_MODEL, then DS_AGENT_MODEL', () => {
    expect(resolveLiveApi({
      DS_AGENT_API_BASE: 'https://api.deepseek.com',
      DS_AGENT_API_KEY: 'k',
      DS_AGENT_API_MODEL: 'deepseek-v4-pro',
      DS_AGENT_MODEL: 'ignored',
    })?.model).toBe('deepseek-v4-pro')
    expect(resolveLiveApi({
      DS_AGENT_API_BASE: 'https://api.deepseek.com',
      DS_AGENT_API_KEY: 'k',
      DS_AGENT_MODEL: 'deepseek-chat',
    })?.model).toBe('deepseek-chat')
    expect(resolveLiveApi({
      MOONSHOT_API_KEY: 'k',
      DS_AGENT_API_MODEL: 'kimi-k3.1-pro-highspeed',
    })?.model).toBe('kimi-k3.1-pro-highspeed')
  })

  it('refuses MockModel when only one of base or key is set', () => {
    expect(() => resolveLiveApi({ DS_AGENT_API_KEY: 'k', OPENAI_API_KEY: 'other' }))
      .toThrow(/DS_AGENT_API_KEY is set but DS_AGENT_API_BASE is missing; refusing MockModel/)
    expect(() => resolveLiveApi({ DS_AGENT_API_BASE: 'https://api.deepseek.com' }))
      .toThrow(/DS_AGENT_API_BASE is set but DS_AGENT_API_KEY is missing; refusing MockModel/)
    expect(() => createModelFromEnv({ DS_AGENT_API_KEY: 'k' })).toThrow(/refusing MockModel/)
    expect(() => demoModel({ DS_AGENT_API_BASE: 'https://api.deepseek.com' })).toThrow(/refusing MockModel/)
  })

  it('maps each provider key to its OpenAI-compatible base without calling the network', () => {
    const original = globalThis.fetch
    globalThis.fetch = () => {
      throw new Error('network')
    }
    try {
      for (const row of PRESET_ROWS) {
        const live = resolveLiveApi({ [row.key]: '  test-key  ' })
        expect(live).toEqual({
          provider: row.provider,
          base: row.base,
          apiKey: 'test-key',
          model: row.model,
        })
        expect(createModelFromEnv({ [row.key]: 'test-key' }).name).toBe('HttpOpenAI')
        expect(requireLiveModelFromEnv({ [row.key]: 'test-key' })).toBeInstanceOf(HttpOpenAI)
        const selected = demoModel({ [row.key]: 'test-key' })
        expect(selected.provider).toBe(row.provider)
        expect(selected.model.name).toBe('HttpOpenAI')
      }
    } finally {
      globalThis.fetch = original
    }
  })

  it('uses the first key listed for a provider and the first preset in scan order', () => {
    expect(resolveLiveApi({
      MOONSHOT_API_KEY: 'moon',
      KIMI_API_KEY: 'kimi',
    })).toMatchObject({ provider: 'moonshot', apiKey: 'moon', base: 'https://api.moonshot.cn/v1' })
    expect(resolveLiveApi({
      ZHIPU_API_KEY: 'zhipu',
      GLM_API_KEY: 'glm',
    })).toMatchObject({ provider: 'zhipu', apiKey: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4' })
    expect(resolveLiveApi({
      XAI_API_KEY: 'xai',
      GROK_API_KEY: 'grok',
    })).toMatchObject({ provider: 'xai', apiKey: 'xai' })
    expect(resolveLiveApi({
      DEEPSEEK_API_KEY: 'ds',
      OPENAI_API_KEY: 'oa',
      KIMI_API_KEY: 'kimi',
    })?.provider).toBe('deepseek')
    expect(resolveLiveApi({
      OPENAI_API_KEY: 'oa',
      KIMI_API_KEY: 'kimi',
    })?.provider).toBe('openai')
  })

  it('lets DS_AGENT_PROVIDER select a preset, including aliases', () => {
    expect(resolveLiveApi({
      DS_AGENT_PROVIDER: 'kimi',
      OPENAI_API_KEY: 'oa',
      KIMI_API_KEY: 'kimi-key',
    })).toMatchObject({
      provider: 'moonshot',
      base: 'https://api.moonshot.cn/v1',
      apiKey: 'kimi-key',
      model: 'kimi-k3.1-pro',
    })
    expect(resolveLiveApi({
      DS_AGENT_PROVIDER: 'Grok',
      GROK_API_KEY: 'grok-key',
      OPENAI_API_KEY: 'oa',
    })?.provider).toBe('xai')
    expect(resolveLiveApi({
      DS_AGENT_PROVIDER: 'glm',
      GLM_API_KEY: 'glm-key',
    })).toMatchObject({ provider: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4' })
    expect(resolveLiveApi({ DS_AGENT_PROVIDER: 'google', GOOGLE_API_KEY: 'g' })?.provider).toBe('gemini')
    expect(resolveLiveApi({ DS_AGENT_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'a' })?.provider).toBe('anthropic')
  })

  it('uses the provider key before DS_AGENT_API_KEY when a preset is selected', () => {
    expect(resolveLiveApi({
      DS_AGENT_PROVIDER: 'moonshot',
      MOONSHOT_API_KEY: 'moon',
      DS_AGENT_API_KEY: 'generic',
    })?.apiKey).toBe('moon')
    expect(resolveLiveApi({
      DS_AGENT_PROVIDER: 'moonshot',
      DS_AGENT_API_KEY: 'generic',
    })).toMatchObject({
      provider: 'moonshot',
      base: 'https://api.moonshot.cn/v1',
      apiKey: 'generic',
    })
  })

  it('throws for an unknown provider, a provider with no key, and custom without a pair', () => {
    expect(() => resolveLiveApi({ DS_AGENT_PROVIDER: 'nope', OPENAI_API_KEY: 'k' })).toThrow(/Unknown DS_AGENT_PROVIDER/)
    expect(() => resolveLiveApi({ DS_AGENT_PROVIDER: 'zhipu' })).toThrow(/no API key/)
    expect(() => resolveLiveApi({ DS_AGENT_PROVIDER: 'custom' })).toThrow(/DS_AGENT_PROVIDER=custom/)
    expect(() => requireLiveModelFromEnv({})).toThrow(/No live model configured; refusing MockModel/)
  })

  it('lists the documented presets in priority order', () => {
    expect(PROVIDER_PRESETS.map(preset => preset.id)).toEqual([
      'deepseek',
      'openai',
      'openrouter',
      'xai',
      'moonshot',
      'zhipu',
      'gemini',
      'anthropic',
    ])
    expect(PROVIDER_PRESETS.every(preset => preset.base.startsWith('https://') && preset.defaultModel.length > 0)).toBe(true)
  })
})
