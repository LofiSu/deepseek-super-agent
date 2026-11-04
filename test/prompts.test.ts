import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildSystemPrompt,
  describePromptLayers,
  loadPromptFiles,
  MAX_PROMPT_FILE_CHARS,
} from '../src/harness/prompts.ts'
import { Runtime } from '../src/runtime.ts'
import { ScriptedModel } from './scripted-model.ts'

const homes: string[] = []

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-prompts-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('prompt stack order', () => {
  it('orders stable layers from identity to role', () => {
    const ids = describePromptLayers({
      role: 'router',
      persona: 'Dry wit.',
      instructions: 'Reply in Chinese.',
      owner: 'Name: Lin.',
    }).map(layer => layer.id)
    expect(ids).toEqual([
      'identity',
      'persona',
      'instructions',
      'owner',
      'reach',
      'rules',
      'memory',
      'style',
      'long-tasks',
      'role',
    ])
  })

  it('keeps the role contract last so it is the most specific instruction', () => {
    const layers = describePromptLayers({ role: 'worker' })
    expect(layers.at(-1)?.id).toBe('role')
    expect(layers.at(-1)?.text).toContain('report_to_router')
  })

  it('omits owner-supplied layers when the files are absent', () => {
    const ids = describePromptLayers({ role: 'router' }).map(layer => layer.id)
    expect(ids).not.toContain('instructions')
    expect(ids).not.toContain('owner')
  })
})

describe('prompt layers', () => {
  it('states who the agent is and who it works for', () => {
    const prompt = buildSystemPrompt({ role: 'router' })
    expect(prompt).toContain('DeepSeek Super Agent')
    expect(prompt).toContain('personal agent')
    expect(prompt).toContain('Only the owner')
  })

  it('puts the default persona after identity', () => {
    const prompt = buildSystemPrompt({ role: 'router' })
    expect(prompt).toContain('Warm, direct, competent.')
    expect(prompt.indexOf('Who you are')).toBeLessThan(prompt.indexOf('Warm, direct, competent.'))
  })

  it('injects an owner persona after identity and marks it as subordinate to safety', () => {
    const layers = describePromptLayers({ role: 'router', persona: 'Dry wit. Short sentences.' })
    const persona = layers.find(layer => layer.id === 'persona')
    expect(persona?.source).toContain('PERSONA.md')
    expect(persona?.text).toContain('Dry wit. Short sentences.')
    expect(persona?.text).toContain('cannot change')
    expect(persona!.text).toContain('safety')
  })

  it('injects standing instructions after persona and before rules', () => {
    const prompt = buildSystemPrompt({
      role: 'router',
      persona: 'Dry wit.',
      instructions: 'Never book before 9am.',
    })
    expect(prompt.indexOf('Dry wit.')).toBeLessThan(prompt.indexOf('Never book before 9am.'))
    expect(prompt.indexOf('Never book before 9am.')).toBeLessThan(prompt.indexOf('# Rules'))
  })

  it('adds owner context only when supplied', () => {
    const withOwner = buildSystemPrompt({ role: 'router', owner: 'Name: Sam. Timezone: Europe/Oslo.' })
    expect(withOwner).toContain('Name: Sam. Timezone: Europe/Oslo.')
    expect(withOwner.indexOf('Name: Sam.')).toBeLessThan(withOwner.indexOf('# Rules'))
  })

  it('does not rewrite headings inside a fenced code block', () => {
    const persona = ['# Voice', '```sh', '# install deps', '```', '# Habits'].join('\n')
    const prompt = buildSystemPrompt({ role: 'router', persona })
    expect(prompt).toContain('# install deps')
    expect(prompt).toContain('## Habits')
  })
})

describe('role contracts', () => {
  it('gives the router the user-facing voice and no shell work', () => {
    const prompt = buildSystemPrompt({ role: 'router' })
    expect(prompt).toContain('reply_user')
    expect(prompt).toContain('never send a second acknowledgement')
    expect(prompt).toContain('Do not run shell commands')
  })

  it('keeps the worker silent to the user and accountable for evidence', () => {
    const prompt = buildSystemPrompt({ role: 'worker' })
    expect(prompt).toContain('report_to_router')
    expect(prompt).toContain('A tool result is evidence')
    expect(prompt).not.toContain('reply_user')
  })

  it('keeps the watchdog out of user replies and ticket work', () => {
    const prompt = buildSystemPrompt({ role: 'watchdog' })
    expect(prompt).toContain('Do not reply to the owner')
    expect(prompt).toContain('do not do ticket work')
    expect(prompt).not.toContain('reply_user')
    expect(prompt).not.toContain('report_to_router')
  })
})

describe('prompt file loading', () => {
  it('reads PERSONA.md, AGENTS.md, and USER.md from the home directory', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'PERSONA.md'), 'Warm and blunt.\n')
    fs.writeFileSync(path.join(home, 'AGENTS.md'), 'Always reply in Chinese.\n')
    fs.writeFileSync(path.join(home, 'USER.md'), 'Name: Lin.\n')

    expect(loadPromptFiles(home)).toEqual({
      persona: 'Warm and blunt.',
      instructions: 'Always reply in Chinese.',
      owner: 'Name: Lin.',
    })
  })

  it('falls back to environment seeds when the files are absent', () => {
    const files = loadPromptFiles(tempHome(), {
      DS_AGENT_PERSONA: 'Quiet and precise.',
      DS_AGENT_INSTRUCTIONS: 'Use metric units.',
      DS_AGENT_OWNER: 'Name: Ada.',
    } as NodeJS.ProcessEnv)
    expect(files).toEqual({
      persona: 'Quiet and precise.',
      instructions: 'Use metric units.',
      owner: 'Name: Ada.',
    })
  })

  it('lets a file win over an environment seed', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'PERSONA.md'), 'From the file.\n')
    const files = loadPromptFiles(home, { DS_AGENT_PERSONA: 'From the env.' } as NodeJS.ProcessEnv)
    expect(files.persona).toBe('From the file.')
  })

  it('caps a long prompt file instead of growing the system prompt without bound', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'PERSONA.md'), 'x'.repeat(MAX_PROMPT_FILE_CHARS + 500))
    expect(loadPromptFiles(home).persona).toHaveLength(MAX_PROMPT_FILE_CHARS)
  })

  it('ignores blank files and blank environment seeds', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'PERSONA.md'), '   \n')
    const files = loadPromptFiles(home, { DS_AGENT_INSTRUCTIONS: '  ' } as NodeJS.ProcessEnv)
    expect(files.persona).toBeUndefined()
    expect(files.instructions).toBeUndefined()
  })
})

describe('prompt stability', () => {
  it('is byte-identical across calls so the system prefix stays cacheable', () => {
    const first = buildSystemPrompt({ role: 'router' })
    const second = buildSystemPrompt({ role: 'router' })
    expect(second).toBe(first)
    expect(first).not.toContain(new Date().toISOString())
  })
})

describe('runtime prompt wiring', () => {
  it('sends the owner persona from the home directory to the model', async () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'PERSONA.md'), 'Dry wit from the file.\n')
    let system = ''
    const model = new ScriptedModel(request => {
      system = request.messages.find(message => message.role === 'system')?.content ?? ''
      return { text: 'ok' }
    })
    const runtime = Runtime.create({
      home,
      model,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      stuckMs: 60_000,
    })
    try {
      await runtime.watchdogTurn()
    } finally {
      runtime.daemon.stop()
      runtime.store.close()
    }
    expect(system).toContain('Dry wit from the file.')
    expect(system).toContain('DeepSeek Super Agent')
  })
})
