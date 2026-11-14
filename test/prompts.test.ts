import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERSONA,
  buildSystemPrompt,
  describePromptSections,
} from '../src/harness/prompts.ts'

const ALL_FILES = {
  soul: 'Dry wit. Short sentences.',
  identity: 'Name: Ada.',
  user: 'Name: Lin. Timezone: Europe/Oslo.',
  instructions: 'Always reply in Chinese.',
  agents: 'Keep exports in workspace/exports.',
  memory: 'Prefers metric units.',
  tools: 'The staging host is stage-1.',
  heartbeat: 'Check the deploy at 08:00.',
  proactivePreferences: 'Tell me about failed deploys.',
} as const

const ALL_IDS = [
  'who-you-are', 'values', 'soul', 'identity', 'built-by', 'who-you-work-for',
  'user', 'standing-instructions', 'discretion', 'external-parties',
  'how-you-work', 'how-you-evolve', 'agents-manual', 'proactivity',
  'proactive-preferences', 'personalization', 'memory', 'contextual-awareness',
  'conversation-context', 'writing-style', 'environment', 'tools',
  'tools-notes', 'team', 'skills', 'scheduled-work', 'heartbeat', 'channels',
  'runtime-files', 'filesystem', 'security', 'safety', 'role',
] as const

const NO_FILE_IDS = [
  'who-you-are', 'values', 'soul', 'built-by', 'who-you-work-for',
  'discretion', 'external-parties', 'how-you-work', 'how-you-evolve',
  'proactivity', 'personalization', 'contextual-awareness',
  'conversation-context', 'writing-style', 'environment', 'tools', 'team',
  'scheduled-work', 'channels', 'runtime-files', 'filesystem', 'security',
  'safety', 'role',
] as const

describe('prompt section order', () => {
  it('always renders the default soul and omits absent owner files', () => {
    const sections = describePromptSections({ role: 'router' })
    expect(sections.map(section => section.id)).toEqual(NO_FILE_IDS)
    expect(buildSystemPrompt({ role: 'router' })).toContain(DEFAULT_PERSONA)
  })

  it('renders every section in order when all files and skills are supplied', () => {
    const sections = describePromptSections({
      role: 'router',
      ...ALL_FILES,
      skills: [{ id: 'deploy', description: 'Check the deploy.' }],
    })
    expect(sections.map(section => section.id)).toEqual(ALL_IDS)
  })

  it('keeps safety immediately before the role contract', () => {
    const sections = describePromptSections({ role: 'worker' })
    expect(sections.at(-1)?.id).toBe('role')
    expect(sections.at(-2)?.id).toBe('safety')
  })
})

describe('built-in section content', () => {
  it('states who the agent is, who built it, and who it works for', () => {
    const prompt = buildSystemPrompt({ role: 'router' })
    expect(prompt).toContain('DeepSeek Super Agent')
    expect(prompt).toContain('not an official DeepSeek product')
    expect(prompt).toContain('one person')
    expect(prompt).toContain('not your principal')
  })

  it('keeps the router contract phrases', () => {
    const prompt = buildSystemPrompt({ role: 'router' })
    expect(prompt).toContain('reply_user')
    expect(prompt).toContain('direct-chat=true')
    expect(prompt).toContain('Keep the conversation going')
    expect(prompt).toContain('Be proactive')
    expect(prompt).toContain('their preference wins')
    expect(prompt).toContain('short quote')
  })

  it('keeps the worker and watchdog contracts distinct', () => {
    const worker = buildSystemPrompt({ role: 'worker' })
    expect(worker).toContain('report_to_router')
    expect(worker).toContain('A tool result is evidence')
    expect(worker).not.toContain('reply_user')

    const watchdog = buildSystemPrompt({ role: 'watchdog' })
    expect(watchdog).toContain('Do not reply to the owner')
    expect(watchdog).toContain('do not do ticket work')
    expect(watchdog).not.toContain('reply_user')
    expect(watchdog).not.toContain('report_to_router')
  })

  it('is byte-identical across calls', () => {
    const first = buildSystemPrompt({ role: 'router' })
    const second = buildSystemPrompt({ role: 'router' })
    expect(second).toBe(first)
    expect(first).not.toContain(new Date().toISOString())
  })
})
