/**
 * OpenAI-compatible provider presets.
 *
 * `resolveLiveApi` never calls the network. HttpOpenAI appends `/chat/completions`
 * and sends `Authorization: Bearer`. Scan order is the priority when several keys
 * are set and `DS_AGENT_PROVIDER` is unset.
 *
 * `DS_AGENT_API_BASE` + `DS_AGENT_API_KEY` together win over every preset. With
 * that pair and no model name, the model stays `deepseek-chat`.
 * A Base without a Key, or a Key without a Base (and without `DS_AGENT_PROVIDER`),
 * throws. Callers must not turn that into MockModel.
 */

export interface ProviderPreset {
  id: string
  label: string
  base: string
  defaultModel: string
  keyEnv: readonly string[]
  aliases: readonly string[]
}

export interface LiveApi {
  /** Preset id, or `custom` when base and key are both set explicitly. */
  provider: string
  base: string
  apiKey: string
  model: string
}

/** Documented chat models. `DS_AGENT_API_MODEL` or `DS_AGENT_MODEL` overrides them. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    base: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    keyEnv: ['DEEPSEEK_API_KEY'],
    aliases: [],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    base: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyEnv: ['OPENAI_API_KEY'],
    aliases: [],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    keyEnv: ['OPENROUTER_API_KEY'],
    aliases: [],
  },
  {
    id: 'xai',
    label: 'xAI',
    base: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.7',
    keyEnv: ['XAI_API_KEY', 'GROK_API_KEY'],
    aliases: ['grok'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    base: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3.1-pro',
    keyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    aliases: ['kimi'],
  },
  {
    id: 'zhipu',
    label: 'Zhipu',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3',
    keyEnv: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
    aliases: ['glm'],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.8-flash',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    aliases: ['google'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    base: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-opus-5-5',
    keyEnv: ['ANTHROPIC_API_KEY'],
    aliases: ['claude'],
  },
]

const EXPLICIT_MODEL_FALLBACK = 'deepseek-chat'

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  return value.length > 0 ? value : undefined
}

function modelName(env: NodeJS.ProcessEnv, fallback: string): string {
  return readEnv(env, 'DS_AGENT_API_MODEL') || readEnv(env, 'DS_AGENT_MODEL') || fallback
}

function presetKey(env: NodeJS.ProcessEnv, preset: ProviderPreset): string | undefined {
  for (const name of preset.keyEnv) {
    const value = readEnv(env, name)
    if (value) return value
  }
  return undefined
}

function findPreset(name: string): ProviderPreset | undefined {
  const id = name.toLowerCase()
  return PROVIDER_PRESETS.find(preset => preset.id === id || preset.aliases.includes(id))
}

function knownProviders(): string {
  return PROVIDER_PRESETS.map(preset => preset.id).join(', ')
}

/**
 * Resolve a live OpenAI-compatible endpoint from env, or `null` when nothing is configured.
 * Throws on a partial explicit config so callers cannot fall through to MockModel.
 */
export function resolveLiveApi(env: NodeJS.ProcessEnv = process.env): LiveApi | null {
  const base = readEnv(env, 'DS_AGENT_API_BASE')
  const key = readEnv(env, 'DS_AGENT_API_KEY')
  const providerName = readEnv(env, 'DS_AGENT_PROVIDER')?.toLowerCase()

  if (base && key) {
    return {
      provider: 'custom',
      base,
      apiKey: key,
      model: modelName(env, EXPLICIT_MODEL_FALLBACK),
    }
  }
  if (base && !key) {
    throw new Error('DS_AGENT_API_BASE is set but DS_AGENT_API_KEY is missing; refusing MockModel.')
  }
  if (key && !base && !providerName) {
    throw new Error('DS_AGENT_API_KEY is set but DS_AGENT_API_BASE is missing; refusing MockModel.')
  }
  if (providerName) {
    if (providerName === 'custom') {
      throw new Error('DS_AGENT_PROVIDER=custom needs DS_AGENT_API_BASE and DS_AGENT_API_KEY; refusing MockModel.')
    }
    const preset = findPreset(providerName)
    if (!preset) {
      throw new Error(`Unknown DS_AGENT_PROVIDER "${providerName.slice(0, 64)}". Known: ${knownProviders()}.`)
    }
    const apiKey = presetKey(env, preset) || key
    if (!apiKey) {
      throw new Error(
        `DS_AGENT_PROVIDER=${preset.id} has no API key (${preset.keyEnv.join(', ')}, or DS_AGENT_API_KEY); refusing MockModel.`,
      )
    }
    return {
      provider: preset.id,
      base: preset.base,
      apiKey,
      model: modelName(env, preset.defaultModel),
    }
  }
  for (const preset of PROVIDER_PRESETS) {
    const apiKey = presetKey(env, preset)
    if (!apiKey) continue
    return {
      provider: preset.id,
      base: preset.base,
      apiKey,
      model: modelName(env, preset.defaultModel),
    }
  }
  return null
}
