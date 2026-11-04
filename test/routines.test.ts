import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadRoutines,
  MAX_ROUTINES,
  RoutineScheduler,
  routineTrigger,
  type RoutineSpec,
} from '../src/harness/routines.ts'
import { Runtime } from '../src/runtime.ts'
import { ScriptedModel } from './scripted-model.ts'

const homes: string[] = []
const runtimes: Runtime[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-routines-'))
  homes.push(dir)
  return dir
}

function spec(overrides: Partial<RoutineSpec> = {}): RoutineSpec {
  return {
    id: 'deploy-check',
    everyMinutes: 60,
    prompt: 'Check production health and report only failures.',
    source: 'cli',
    thread: 'local',
    actor: 'you',
    ...overrides,
  }
}

function writeRoutines(home: string, value: unknown): void {
  fs.writeFileSync(path.join(home, 'routines.json'), JSON.stringify(value))
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.daemon.stop()
    runtime.store.close()
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('routine configuration', () => {
  it('loads a list and fills owner-channel defaults', () => {
    const home = tempHome()
    writeRoutines(home, [{
      id: 'deploy-check',
      everyMinutes: 60,
      prompt: 'Check production health.',
    }])
    expect(loadRoutines(home)).toEqual([spec({ prompt: 'Check production health.' })])
  })

  it('accepts a {"routines": [...]} wrapper', () => {
    const home = tempHome()
    writeRoutines(home, { routines: [{ id: 'morning', everyMinutes: 30, prompt: 'Brief me.' }] })
    expect(loadRoutines(home).map(routine => routine.id)).toEqual(['morning'])
  })

  it('returns nothing when the file is absent or blank', () => {
    expect(loadRoutines(tempHome())).toEqual([])
  })

  it('reads the environment seed when no file exists, and the file wins', () => {
    const home = tempHome()
    const env = {
      DS_AGENT_ROUTINES: JSON.stringify([{ id: 'seeded', everyMinutes: 30, prompt: 'Seed.' }]),
    }
    expect(loadRoutines(home, env).map(routine => routine.id)).toEqual(['seeded'])
    writeRoutines(home, [{ id: 'from-file', everyMinutes: 30, prompt: 'File.' }])
    expect(loadRoutines(home, env).map(routine => routine.id)).toEqual(['from-file'])
  })

  it('rejects duplicate ids', () => {
    const home = tempHome()
    writeRoutines(home, [
      { id: 'same', everyMinutes: 30, prompt: 'One.' },
      { id: 'same', everyMinutes: 60, prompt: 'Two.' },
    ])
    expect(() => loadRoutines(home)).toThrow(/duplicate routine id/)
  })

  it('rejects an interval outside the supported range', () => {
    const home = tempHome()
    for (const everyMinutes of [0, 4, 10_081, 1.5]) {
      writeRoutines(home, [{ id: 'bad', everyMinutes, prompt: 'Bad.' }])
      expect(() => loadRoutines(home), String(everyMinutes)).toThrow(/everyMinutes/)
    }
  })

  it('rejects an empty prompt and an unknown key', () => {
    const home = tempHome()
    writeRoutines(home, [{ id: 'empty', everyMinutes: 30, prompt: '   ' }])
    expect(() => loadRoutines(home)).toThrow(/prompt/)
    writeRoutines(home, [{ id: 'unknown', everyMinutes: 30, prompt: 'Work.', shell: 'rm -rf /' }])
    expect(() => loadRoutines(home)).toThrow(/unknown key shell/)
  })

  it('caps the number of routines', () => {
    const home = tempHome()
    const list = Array.from({ length: MAX_ROUTINES + 1 }, (_, index) => ({
      id: `routine-${index}`,
      everyMinutes: 60,
      prompt: 'Work.',
    }))
    writeRoutines(home, list)
    expect(() => loadRoutines(home)).toThrow(new RegExp(`at most ${MAX_ROUTINES}`))
  })

  it('rejects a source the filter would drop', () => {
    const home = tempHome()
    writeRoutines(home, [{ id: 'bad', everyMinutes: 30, prompt: 'Work.', source: 'routine' }])
    expect(() => loadRoutines(home)).toThrow(/source/)
  })
})

describe('routine scheduling', () => {
  function makeScheduler(options: {
    specs?: RoutineSpec[]
    lastRun?: Map<string, number>
    fired?: ReturnType<typeof routineTrigger>[]
  } = {}) {
    const lastRun = options.lastRun ?? new Map<string, number>()
    const fired = options.fired ?? []
    const runner = new RoutineScheduler(options.specs ?? [spec()], {
      now: () => 0,
      lastRun: id => lastRun.get(id),
      saveLastRun: (id, at) => { lastRun.set(id, at) },
      fire: trigger => { fired.push(trigger) },
    })
    return { scheduler: runner, lastRun, fired }
  }

  it('arms a new routine without firing it on the first tick', () => {
    const { scheduler: runner, fired, lastRun } = makeScheduler()
    expect(runner.tick(1_000_000)).toEqual([])
    expect(fired).toEqual([])
    expect(lastRun.get('deploy-check')).toBe(1_000_000)
  })

  it('fires once when the interval has elapsed', () => {
    const { scheduler: runner, fired, lastRun } = makeScheduler()
    runner.tick(1_000_000)
    expect(runner.tick(1_000_000 + 59 * 60_000)).toEqual([])
    expect(runner.tick(1_000_000 + 60 * 60_000)).toEqual(['deploy-check'])
    expect(fired).toHaveLength(1)
    expect(lastRun.get('deploy-check')).toBe(1_000_000 + 60 * 60_000)
  })

  it('fires once for a long gap instead of replaying every missed slot', () => {
    const { scheduler: runner, fired } = makeScheduler()
    runner.tick(1_000_000)
    expect(runner.tick(1_000_000 + 5 * 60 * 60_000)).toEqual(['deploy-check'])
    expect(fired).toHaveLength(1)
  })

  it('does not refire from a persisted lastRun after a restart', () => {
    const lastRun = new Map([['deploy-check', 1_000_000]])
    const { scheduler: runner, fired } = makeScheduler({ lastRun })
    expect(runner.tick(1_000_000 + 30 * 60_000)).toEqual([])
    expect(fired).toEqual([])
  })

  it('ignores a clock that moves backwards', () => {
    const { scheduler: runner, fired } = makeScheduler()
    runner.tick(2_000_000)
    expect(runner.tick(1_000_000)).toEqual([])
    expect(fired).toEqual([])
  })

  it('keeps one bad routine from blocking the others', () => {
    const broken: RoutineSpec = spec({ id: 'broken' })
    const working: RoutineSpec = spec({ id: 'working' })
    const lastRun = new Map([['broken', 1_000_000], ['working', 1_000_000]])
    const fired: ReturnType<typeof routineTrigger>[] = []
    const runner = new RoutineScheduler([broken, working], {
      now: () => 0,
      lastRun: id => lastRun.get(id),
      saveLastRun: () => {},
      fire: trigger => {
        fired.push(trigger)
        if (trigger.meta.routine === 'broken') throw new Error('boom')
      },
    })
    expect(runner.tick(1_000_000 + 61 * 60_000).sort()).toEqual(['broken', 'working'])
    expect(fired.map(trigger => trigger.meta.routine)).toEqual(['broken', 'working'])
  })
})

describe('routine trigger', () => {
  it('is an owner-authored direct trigger on the configured channel', () => {
    const trigger = routineTrigger(spec({ source: 'imessage', thread: 'chat_42', actor: 'owner' }), '2026-11-05T08:00:00.000Z')
    expect(trigger).toMatchObject({
      source: 'imessage',
      human: true,
      addressed: 'direct',
      at: '2026-11-05T08:00:00.000Z',
      text: 'Check production health and report only failures.',
      actor: { source: 'imessage', id: 'owner' },
      threads: [{ source: 'imessage', id: 'chat_42' }],
      channel: { source: 'imessage', thread: 'chat_42' },
      meta: { routine: 'deploy-check' },
    })
    expect(trigger.id).toMatch(/^trg_routine_deploy-check_\d+$/)
  })

  it('uses a stable id for the same due slot so a retry is a duplicate', () => {
    const first = routineTrigger(spec(), '2026-11-05T08:00:00.000Z')
    const second = routineTrigger(spec(), '2026-11-05T08:00:00.000Z')
    expect(second.id).toBe(first.id)
  })
})

describe('runtime routine wiring', () => {
  it('injects a due routine into ingress and persists its last run', async () => {
    const home = tempHome()
    writeRoutines(home, [{
      id: 'deploy-check',
      everyMinutes: 5,
      prompt: 'Check production health and report only failures.',
    }])
    let clock = Date.parse('2026-11-05T08:00:00.000Z')
    const runtime = Runtime.create({
      home,
      model: new ScriptedModel(() => ({ text: 'green' })),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      now: () => new Date(clock).toISOString(),
    })
    runtimes.push(runtime)
    expect(runtime.routines?.list().map(routine => routine.id)).toEqual(['deploy-check'])

    runtime.daemon.tick(clock)
    expect(runtime.store.listDocs('trigger')).toHaveLength(0)

    clock += 5 * 60_000
    runtime.daemon.tick(clock)
    const triggers = runtime.store.listDocs<{ id: string; source: string; text: string }>('trigger')
    expect(triggers).toHaveLength(1)
    expect(triggers[0]?.source).toBe('cli')
    expect(triggers[0]?.id).toMatch(/^trg_routine_deploy-check_\d+$/)
    expect(triggers[0]?.text).toContain('Check production health')
    expect(runtime.store.getDoc<{ lastRunAt: number }>('routine', 'deploy-check')?.lastRunAt)
      .toBe(clock)
  })
})
