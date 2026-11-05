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
import { Daemon } from '../src/harness/daemon.ts'
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
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'routines.json'), '  \n')
    const env = { DS_AGENT_ROUTINES: JSON.stringify([{ id: 'seeded', everyMinutes: 30, prompt: 'Seed.' }]) }
    // A blank owner file wins over the env seed instead of throwing.
    expect(loadRoutines(home, env)).toEqual([])
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

  it('re-arms instead of stalling after a large backward clock jump', () => {
    const lastRun = new Map([['deploy-check', 10_000_000_000]])
    const { scheduler: runner, fired } = makeScheduler({ lastRun })
    expect(runner.tick(1_000_000)).toEqual([])
    expect(fired).toEqual([])
    expect(lastRun.get('deploy-check')).toBe(1_000_000)
  })

  it('re-arms a corrupt persisted last-run instead of throwing', () => {
    const lastRun = new Map([['deploy-check', Number.NaN]])
    const { scheduler: runner, fired } = makeScheduler({ lastRun })
    expect(() => runner.tick(1_000_000)).not.toThrow()
    expect(fired).toEqual([])
    expect(lastRun.get('deploy-check')).toBe(1_000_000)
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

describe('daily routine scheduling', () => {
  const THURSDAY_0800 = Date.UTC(2026, 10, 5, 8, 0)
  const THURSDAY_1200 = Date.UTC(2026, 10, 5, 12, 0)
  const FRIDAY_0800 = Date.UTC(2026, 10, 6, 8, 0)
  const SATURDAY_1200 = Date.UTC(2026, 10, 7, 12, 0)
  const MONDAY_0800 = Date.UTC(2026, 10, 9, 8, 0)

  function daily(overrides: Record<string, unknown> = {}): RoutineSpec {
    return {
      id: 'morning',
      at: '08:00',
      days: [0, 1, 2, 3, 4, 5, 6],
      prompt: 'Brief me.',
      source: 'cli',
      thread: 'local',
      actor: 'you',
      ...overrides,
    } as RoutineSpec
  }

  function runnerFor(spec: RoutineSpec): {
    runner: RoutineScheduler
    fired: ReturnType<typeof routineTrigger>[]
    lastRun: Map<string, number>
  } {
    const lastRun = new Map<string, number>()
    const fired: ReturnType<typeof routineTrigger>[] = []
    const runner = new RoutineScheduler([spec], {
      now: () => 0,
      lastRun: id => lastRun.get(id),
      saveLastRun: (id, at) => { lastRun.set(id, at) },
      fire: trigger => { fired.push(trigger) },
    })
    return { runner, fired, lastRun }
  }

  it('parses a daily routine, defaults to every day, and sorts days', () => {
    const home = tempHome()
    writeRoutines(home, [
      { id: 'morning', at: '08:00', prompt: 'Brief me.' },
      { id: 'weekday', at: '09:30', days: [5, 1, 3], prompt: 'Standup.' },
    ])
    expect(loadRoutines(home)).toEqual([
      daily({ at: '08:00' }),
      daily({ id: 'weekday', at: '09:30', days: [1, 3, 5], prompt: 'Standup.' }),
    ])
  })

  it('rejects ambiguous, missing, or malformed daily schedules', () => {
    const home = tempHome()
    for (const bad of [
      { id: 'both', everyMinutes: 60, at: '08:00', prompt: 'Ambiguous.' },
      { id: 'neither', prompt: 'Nothing.' },
      { id: 'bad-time', at: '8:00', prompt: 'Bad.' },
      { id: 'bad-hour', at: '24:00', prompt: 'Bad.' },
      { id: 'bad-minute', at: '08:60', prompt: 'Bad.' },
      { id: 'empty-days', at: '08:00', days: [], prompt: 'Bad.' },
      { id: 'bad-day', at: '08:00', days: [7], prompt: 'Bad.' },
      { id: 'dup-days', at: '08:00', days: [1, 1], prompt: 'Bad.' },
    ]) {
      writeRoutines(home, [bad])
      expect(() => loadRoutines(home), JSON.stringify(bad)).toThrow()
    }
  })

  it('arms at the most recent due slot instead of firing on first sight', () => {
    const { runner, fired, lastRun } = runnerFor(daily())
    expect(runner.tick(THURSDAY_1200)).toEqual([])
    expect(fired).toEqual([])
    expect(lastRun.get('morning')).toBe(THURSDAY_0800)
  })

  it('fires once at the slot and not again until the next slot', () => {
    const { runner, fired, lastRun } = runnerFor(daily())
    runner.tick(THURSDAY_0800 - 60_000)
    expect(runner.tick(THURSDAY_0800)).toEqual(['morning'])
    expect(fired).toHaveLength(1)
    expect(fired[0]?.at).toBe('2026-11-05T08:00:00.000Z')
    expect(lastRun.get('morning')).toBe(THURSDAY_0800)
    expect(runner.tick(THURSDAY_0800 + 60 * 60_000)).toEqual([])
    expect(fired).toHaveLength(1)
    expect(runner.tick(FRIDAY_0800 + 5 * 60_000)).toEqual(['morning'])
    expect(fired).toHaveLength(2)
  })

  it('skips days that are not selected', () => {
    const { runner, fired } = runnerFor(daily({ days: [1, 2, 3, 4, 5] }))
    runner.tick(FRIDAY_0800 - 60_000)
    expect(runner.tick(FRIDAY_0800)).toEqual(['morning'])
    expect(runner.tick(SATURDAY_1200)).toEqual([])
    expect(runner.tick(MONDAY_0800)).toEqual(['morning'])
    expect(fired).toHaveLength(2)
  })

  it('fires once for a long gap and uses the latest slot as the trigger time', () => {
    const { runner, fired } = runnerFor(daily())
    runner.tick(THURSDAY_0800 - 60_000)
    runner.tick(THURSDAY_0800)
    expect(runner.tick(MONDAY_0800 + 30 * 60_000)).toEqual(['morning'])
    expect(fired).toHaveLength(2)
    expect(fired[1]?.at).toBe('2026-11-09T08:00:00.000Z')
  })

  it('ignores a clock that moves back before the last slot', () => {
    const { runner, fired } = runnerFor(daily())
    runner.tick(THURSDAY_1200)
    expect(runner.tick(THURSDAY_0800 - 60_000)).toEqual([])
    expect(fired).toEqual([])
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

  it('carries an owner-configured group into the channel address', () => {
    const trigger = routineTrigger(spec({ group: 'group_42' }), '2026-11-05T08:00:00.000Z')
    expect(trigger.channel).toEqual({ source: 'cli', thread: 'local', address: { group: 'group_42' } })
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

  it('does not tick routines on a one-shot start, only on the serving pulse', () => {
    const home = tempHome()
    writeRoutines(home, [{
      id: 'deploy-check',
      everyMinutes: 5,
      prompt: 'Check production health and report only failures.',
    }])
    const clock = Date.parse('2026-11-05T08:00:00.000Z')
    const runtime = Runtime.create({
      home,
      model: new ScriptedModel(() => ({ text: 'green' })),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      now: () => new Date(clock).toISOString(),
    })
    runtimes.push(runtime)
    // Already armed one interval ago: a routine tick now would fire it.
    runtime.store.putDoc('routine', 'deploy-check', { id: 'deploy-check', lastRunAt: clock - 5 * 60_000 })

    runtime.start({ assessPending: false })
    expect(runtime.store.listDocs('trigger')).toHaveLength(0)

    runtime.daemon.tick(clock)
    expect(runtime.store.listDocs('trigger')).toHaveLength(1)
  })

  it('validates programmatic routine specs', () => {
    expect(() => Runtime.create({
      home: tempHome(),
      model: new ScriptedModel(() => ({ text: 'green' })),
      jobDelayMs: 0,
      routines: [{ ...spec(), everyMinutes: 0 }],
    })).toThrow(/everyMinutes/)
  })

  it('catches scheduler and watchdog exceptions in the daemon pulse', () => {
    const lines: string[] = []
    let routineTicks = 0
    const daemon = new Daemon(
      { tick: () => { throw new Error('watchdog boom') }, intervalMs: 60_000 },
      line => lines.push(line),
      undefined,
      undefined,
      { tick: () => { routineTicks += 1; throw new Error('routine boom') } },
    )
    try {
      expect(() => daemon.start({ routines: true })).not.toThrow()
      expect(routineTicks).toBe(1)
      expect(lines.filter(line => line.includes('tick failed'))).toHaveLength(2)
    } finally {
      daemon.stop()
    }
  })
})
