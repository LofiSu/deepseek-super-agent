import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SkillRegistry, loadSkills, MAX_SKILL_BODY_CHARS } from '../src/env/skills.ts'
import { buildSystemPrompt, describePromptLayers } from '../src/harness/prompts.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { Runtime } from '../src/runtime.ts'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { ScriptedModel } from './scripted-model.ts'

const homes: string[] = []
const runtimes: Runtime[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-skills-'))
  homes.push(dir)
  return dir
}

function writeSkill(home: string, id: string, content: string): void {
  const dir = path.join(home, 'skills', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content)
}

function skill(description = 'Check the deploy.', body = '# Deploy\n\nRun the check.'): string {
  return `---\nname: Deploy check\ndescription: ${description}\n---\n\n${body}\n`
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.daemon.stop()
    runtime.store.close()
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('skill loading', () => {
  it('loads SKILL.md files in id order and keeps the body out of the index', () => {
    const home = tempHome()
    writeSkill(home, 'zebra', skill('Last alphabetically.'))
    writeSkill(home, 'deploy', skill('Check the deploy.'))
    const skills = loadSkills(home)
    expect(skills.map(item => item.id)).toEqual(['deploy', 'zebra'])
    expect(skills[0]).toMatchObject({ id: 'deploy', description: 'Check the deploy.' })
    expect(skills[0]).not.toHaveProperty('body')
  })

  it('returns nothing when the directory is absent', () => {
    expect(loadSkills(tempHome())).toEqual([])
  })

  it('skips a skill with no frontmatter description and says why', () => {
    const home = tempHome()
    writeSkill(home, 'broken', '# Just a heading\n')
    writeSkill(home, 'good', skill())
    const problems: string[] = []
    const skills = loadSkills(home, line => problems.push(line))
    expect(skills.map(item => item.id)).toEqual(['good'])
    expect(problems.join('\n')).toContain('broken')
    expect(problems.join('\n')).toContain('description')
  })

  it('skips directory names that are not plain ids', () => {
    const home = tempHome()
    writeSkill(home, 'Bad Id', skill())
    writeSkill(home, 'good', skill())
    const problems: string[] = []
    expect(loadSkills(home, line => problems.push(line)).map(item => item.id)).toEqual(['good'])
    expect(problems.join('\n')).toContain('Bad Id')
  })

  it('ignores a symlinked skill file so a skill cannot point outside the skills directory', () => {
    const home = tempHome()
    const outside = path.join(home, 'outside.md')
    fs.writeFileSync(outside, skill('Outside.'))
    const dir = path.join(home, 'skills', 'linked')
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(outside, path.join(dir, 'SKILL.md'))
    const problems: string[] = []
    expect(loadSkills(home, line => problems.push(line))).toEqual([])
    expect(problems.join('\n')).toContain('linked')
  })

  it('ignores a symlinked skill directory', () => {
    const home = tempHome()
    const real = path.join(home, 'real-skill')
    fs.mkdirSync(real)
    fs.writeFileSync(path.join(real, 'SKILL.md'), skill('Linked directory.'))
    fs.mkdirSync(path.join(home, 'skills'))
    fs.symlinkSync(real, path.join(home, 'skills', 'linked'))
    expect(loadSkills(home)).toEqual([])
  })

  it('trims a quoted description', () => {
    const home = tempHome()
    writeSkill(home, 'quoted', '---\ndescription: "Say \\"hello\\"."\n---\nbody\n')
    expect(loadSkills(home)[0]?.description).toBe('Say "hello".')
  })
})

describe('skill reading', () => {
  it('reads the body without the frontmatter', () => {
    const home = tempHome()
    writeSkill(home, 'deploy', skill('Check the deploy.', '# Deploy\n\nRun the check.'))
    const document = new SkillRegistry(loadSkills(home)).read('deploy')
    expect(document.id).toBe('deploy')
    expect(document.body).toContain('# Deploy')
    expect(document.body).toContain('Run the check.')
    expect(document.body).not.toContain('description:')
    expect(document.truncated).toBe(false)
  })

  it('caps a long body and marks it truncated', () => {
    const home = tempHome()
    writeSkill(home, 'long', skill('Long.', 'x'.repeat(MAX_SKILL_BODY_CHARS + 500)))
    const document = new SkillRegistry(loadSkills(home)).read('long')
    expect(document.body).toHaveLength(MAX_SKILL_BODY_CHARS)
    expect(document.truncated).toBe(true)
  })

  it('rejects an unknown id and a path-like id without touching disk', () => {
    const registry = new SkillRegistry([])
    expect(() => registry.read('../secret')).toThrow(/unknown skill/)
    expect(() => registry.read('nope')).toThrow(/unknown skill/)
  })
})

describe('skill prompt layer', () => {
  it('lists skill ids and descriptions after the team and before reach', () => {
    const layers = describePromptLayers({
      role: 'worker',
      skills: [{ id: 'deploy', description: 'Check the deploy.' }],
    })
    const ids = layers.map(layer => layer.id)
    expect(ids.indexOf('skills')).toBeGreaterThan(ids.indexOf('team'))
    expect(ids.indexOf('skills')).toBeLessThan(ids.indexOf('reach'))
    const text = layers.find(layer => layer.id === 'skills')?.text ?? ''
    expect(text).toContain('deploy')
    expect(text).toContain('Check the deploy.')
    expect(text).toContain('read_skill')
  })

  it('omits the layer when no skills are configured', () => {
    const ids = describePromptLayers({ role: 'router' }).map(layer => layer.id)
    expect(ids).not.toContain('skills')
  })

  it('keeps the index within a fixed budget', () => {
    const skills = Array.from({ length: 64 }, (_, index) => ({
      id: `skill-${index}`,
      description: 'd'.repeat(200),
    }))
    const prompt = buildSystemPrompt({ role: 'worker', skills })
    expect(prompt.length).toBeLessThan(10_000)
    expect(prompt).toContain('skill-0')
  })
})

describe('skill tools', () => {
  it('exposes read_skill to router and worker, never the watchdog', async () => {
    const home = tempHome()
    writeSkill(home, 'deploy', skill('Check the deploy.', 'Step one. Step two.'))
    const runtime = Runtime.create({
      home,
      model: new ScriptedModel(() => ({ text: 'ok' })),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
    })
    runtimes.push(runtime)
    const tools = new ToolRegistry({
      store: runtime.store,
      ports: bindRolePorts(runtime.engine),
      env: new LocalEnv(path.join(runtime.home, 'workspaces')),
      metrics: runtime.metrics,
      redact: text => text,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
      skills: runtime.skills,
    })
    for (const role of ['router', 'worker'] as const) {
      expect((await tools.specsFor(role)).map(spec => spec.name)).toContain('read_skill')
    }
    expect((await tools.specsFor('watchdog')).map(spec => spec.name)).not.toContain('read_skill')

    await expect(tools.invoke(
      { id: 'r1', name: 'read_skill', args: { skill: 'deploy' } },
      { sessionId: 'watchdog', role: 'watchdog' },
    )).rejects.toThrow(/not available to watchdog/)

    const document = await tools.invoke(
      { id: 'r2', name: 'read_skill', args: { skill: 'deploy' } },
      { sessionId: 'worker_ticket_1', role: 'worker', ticketId: 'ticket_1' },
    ) as { id: string; body: string }
    expect(document.id).toBe('deploy')
    expect(document.body).toContain('Step one. Step two.')
  })
})

describe('runtime skill wiring', () => {
  it('injects the owner skills index into the system prompt', async () => {
    const home = tempHome()
    writeSkill(home, 'deploy', skill('Check the deploy health.'))
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
    runtimes.push(runtime)
    await runtime.watchdogTurn()
    expect(system).toContain('deploy')
    expect(system).toContain('Check the deploy health.')
    expect(system).toContain('read_skill')
  })
})
