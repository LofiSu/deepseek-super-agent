import fs from 'node:fs'
import path from 'node:path'
import { UserError } from '../shared/errors.ts'
import type { Trigger } from '../shared/types.ts'

/**
 * Owner-defined routines: "every N minutes, do this". The owner writes
 * `routines.json` in the agent home; the daemon checks due routines on its
 * normal tick and injects the prompt through the regular ingress path.
 *
 * The model cannot create, change, or delete a routine. A routine is a
 * standing instruction from the owner, so it is admitted as an owner-authored
 * direct trigger on the configured channel and still passes the normal filter,
 * rules, sandbox, and approval boundaries. A route that cannot be delivered
 * (an unknown source) is rejected at load time rather than silently dropped.
 */
interface RoutineBase {
  /** Stable id, also the persisted last-run key. */
  id: string
  prompt: string
  /** Channel source the routine fires on. Default `cli`. */
  source: string
  /** Thread id inside that source. Default `local`. */
  thread: string
  /** Actor id the trigger carries. Default `you` (the CLI owner). */
  actor: string
}

/** Fire every N minutes. Bounded: at least 5 minutes, at most 7 days. */
export interface IntervalRoutine extends RoutineBase {
  everyMinutes: number
}

/**
 * Fire once per selected UTC day at `at` (`HH:MM`). `days` uses
 * 0=Sunday..6=Saturday and defaults to every day. Times are UTC because the
 * scheduler must not depend on the host's local zone or DST rules.
 */
export interface DailyRoutine extends RoutineBase {
  at: string
  days: number[]
}

/** Exactly one schedule: an interval or a daily time. */
export type RoutineSpec = IntervalRoutine | DailyRoutine

export interface RoutineSchedulerOptions {
  now: () => number
  /** Persisted time of the last fire (or arm) for this routine. */
  lastRun: (id: string) => number | undefined
  saveLastRun: (id: string, at: number) => void
  /** Ingress the trigger. Must be the Runtime path, not Engine.receive directly. */
  fire: (trigger: Trigger) => void
  log?: (line: string) => void
}

export const ROUTINES_FILE = 'routines.json'
export const ROUTINES_ENV = 'DS_AGENT_ROUTINES'
export const MAX_ROUTINES = 32
export const MIN_ROUTINE_MINUTES = 5
export const MAX_ROUTINE_MINUTES = 10_080
export const MAX_ROUTINE_PROMPT_CHARS = 4_000

/** Sources the ingress fast path admits. A routine cannot target anything else. */
const SOURCES = new Set(['im', 'github', 'cli', 'a2a', 'imessage'])
const ID = /^[a-z][a-z0-9_-]{0,31}$/
const SPEC_KEYS = new Set(['id', 'everyMinutes', 'at', 'days', 'prompt', 'source', 'thread', 'actor'])
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const DAY_MS = 86_400_000
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

/**
 * Read the owner's routines. A missing or blank config means none. A malformed
 * entry fails loudly: unlike a skill, a routine causes work on a schedule, so a
 * silent typo would mean the work never happens.
 */
export function loadRoutines(
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RoutineSpec[] {
  const file = path.join(home, ROUTINES_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new UserError(`${ROUTINES_FILE} is not valid JSON: ${messageOf(error)}`)
    }
    const seed = env[ROUTINES_ENV]?.trim()
    if (!seed) return []
    try {
      raw = JSON.parse(seed)
    } catch (seedError) {
      throw new UserError(`${ROUTINES_ENV} is not valid JSON: ${messageOf(seedError)}`)
    }
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { routines?: unknown }).routines)
      ? (raw as { routines: unknown[] }).routines
      : undefined
  if (!list) throw new UserError(`${ROUTINES_FILE} must be an array or {"routines": [...]}`)
  return normalizeRoutines(list)
}

export function normalizeRoutines(list: readonly unknown[]): RoutineSpec[] {
  if (list.length > MAX_ROUTINES) {
    throw new UserError(`at most ${MAX_ROUTINES} routines may be configured`)
  }
  const seen = new Set<string>()
  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new UserError(`routine #${index + 1} must be an object`)
    }
    const raw = entry as Record<string, unknown>
    for (const key of Object.keys(raw)) {
      if (!SPEC_KEYS.has(key)) throw new UserError(`routine #${index + 1} has unknown key ${key}`)
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!ID.test(id)) throw new UserError(`routine id ${JSON.stringify(raw.id)} is invalid`)
    if (seen.has(id)) throw new UserError(`duplicate routine id ${id}`)
    seen.add(id)

    const hasInterval = raw.everyMinutes !== undefined
    const hasDaily = raw.at !== undefined
    if (hasInterval === hasDaily) {
      throw new UserError(`routine ${id} needs exactly one of everyMinutes or at`)
    }
    let everyMinutes: number | undefined
    let at: string | undefined
    let days: number[] | undefined
    if (hasInterval) {
      const value = raw.everyMinutes
      if (
        typeof value !== 'number'
        || !Number.isInteger(value)
        || value < MIN_ROUTINE_MINUTES
        || value > MAX_ROUTINE_MINUTES
      ) {
        throw new UserError(
          `routine ${id} everyMinutes must be an integer between ${MIN_ROUTINE_MINUTES} and ${MAX_ROUTINE_MINUTES}`,
        )
      }
      if (raw.days !== undefined) {
        throw new UserError(`routine ${id} days only applies to an at schedule`)
      }
      everyMinutes = value
    } else {
      at = parseTime(raw.at, id)
      days = parseDays(raw.days, id)
    }

    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
    if (!prompt) throw new UserError(`routine ${id} needs a prompt`)
    if (prompt.length > MAX_ROUTINE_PROMPT_CHARS) {
      throw new UserError(`routine ${id} prompt is longer than ${MAX_ROUTINE_PROMPT_CHARS} characters`)
    }

    const source = raw.source === undefined ? 'cli' : raw.source
    if (typeof source !== 'string' || !SOURCES.has(source)) {
      throw new UserError(`routine ${id} source must be one of ${[...SOURCES].join(', ')}`)
    }
    const thread = oneLine(raw.thread, id, 'thread', 'local')
    const actor = oneLine(raw.actor, id, 'actor', 'you')
    const base = { id, prompt, source, thread, actor }
    return everyMinutes !== undefined
      ? { ...base, everyMinutes }
      : { ...base, at: at!, days: days! }
  })
}

function parseTime(value: unknown, id: string): string {
  if (typeof value !== 'string' || !TIME.test(value)) {
    throw new UserError(`routine ${id} at must be a UTC HH:MM time`)
  }
  return value
}

function parseDays(value: unknown, id: string): number[] {
  if (value === undefined) return [...ALL_DAYS]
  if (!Array.isArray(value) || value.length === 0) {
    throw new UserError(`routine ${id} days must be a non-empty array of 0..6`)
  }
  const days: number[] = []
  for (const day of value) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new UserError(`routine ${id} days must contain integers 0..6`)
    }
    if (days.includes(day)) throw new UserError(`routine ${id} days has a duplicate`)
    days.push(day)
  }
  return days.sort((a, b) => a - b)
}

function oneLine(value: unknown, id: string, field: string, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new UserError(`routine ${id} ${field} must be one non-empty line`)
  }
  return value.trim()
}

/**
 * Due-checking over persisted last-run times. No timers of its own: the Daemon
 * tick drives it, so tests use a fake clock and the process has one scheduler.
 *
 * First sight of a routine arms it at `now` instead of firing immediately.
 * After that a due routine fires once per tick, even after a long gap; missed
 * slots are not replayed. The trigger id is derived from the due slot, so a
 * crash between fire and save is deduplicated by ingress on retry.
 */
export class RoutineScheduler {
  constructor(
    private readonly specs: readonly RoutineSpec[],
    private readonly opts: RoutineSchedulerOptions,
  ) {}

  list(): RoutineSpec[] {
    return [...this.specs]
  }

  /** Check every routine once. Returns the ids whose prompt was injected. */
  tick(at = this.opts.now()): string[] {
    const fired: string[] = []
    for (const spec of this.specs) {
      const last = this.opts.lastRun(spec.id)
      const daily = isDaily(spec)
      if (last === undefined) {
        // Arm at the latest due slot, so a first tick after 08:00 does not
        // fire immediately and a first tick before it still catches 08:00.
        const arm = daily ? latestDailySlot(at, spec) ?? at : at
        this.opts.saveLastRun(spec.id, arm)
        this.opts.log?.(`[routine] armed id=${spec.id} ${scheduleLabel(spec)}`)
        continue
      }
      if (at < last) {
        this.opts.log?.(`[routine] clock moved backwards id=${spec.id}; skipping`)
        continue
      }
      let due: number
      if (daily) {
        const slot = latestDailySlot(at, spec)
        if (slot === undefined || slot <= last) continue
        due = slot
      } else {
        const dueSlot = last + spec.everyMinutes * 60_000
        if (at < dueSlot) continue
        due = dueSlot
      }
      const trigger = routineTrigger(spec, new Date(due).toISOString())
      fired.push(spec.id)
      try {
        this.opts.fire(trigger)
        // Interval routines save the tick time so missed slots are not
        // replayed; daily routines save the slot so a late tick fires once.
        this.opts.saveLastRun(spec.id, daily ? due : at)
        this.opts.log?.(`[routine] fired id=${spec.id} at=${trigger.at} source=${spec.source}`)
      } catch (error) {
        this.opts.log?.(`[routine] failed id=${spec.id}: ${messageOf(error)}`)
      }
    }
    return fired
  }
}

function isDaily(spec: RoutineSpec): spec is DailyRoutine {
  return 'at' in spec
}

function scheduleLabel(spec: RoutineSpec): string {
  return isDaily(spec)
    ? `at=${spec.at} days=${spec.days.join(',')}`
    : `everyMinutes=${spec.everyMinutes}`
}

/**
 * Most recent UTC slot at or before `now`, walking back up to a week so a
 * selected weekday is always found. Pure: no local timezone, no DST.
 */
export function latestDailySlot(now: number, spec: DailyRoutine): number | undefined {
  const [hours, minutes] = spec.at.split(':').map(Number) as [number, number]
  const sinceMidnight = ((now % DAY_MS) + DAY_MS) % DAY_MS
  let candidate = now - sinceMidnight + hours * 3_600_000 + minutes * 60_000
  if (candidate > now) candidate -= DAY_MS
  for (let back = 0; back <= 7; back += 1) {
    if (spec.days.includes(new Date(candidate).getUTCDay())) return candidate
    candidate -= DAY_MS
  }
  return undefined
}

/** The owner-authored trigger one due slot produces. */
export function routineTrigger(spec: RoutineSpec, at: string): Trigger {
  const due = Date.parse(at)
  return {
    id: `trg_routine_${spec.id}_${Number.isFinite(due) ? due : at}`,
    source: spec.source,
    threads: [{ source: spec.source, id: spec.thread }],
    actor: { source: spec.source, id: spec.actor },
    human: true,
    addressed: 'direct',
    at,
    text: spec.prompt,
    channel: { source: spec.source, thread: spec.thread },
    meta: { routine: spec.id },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
