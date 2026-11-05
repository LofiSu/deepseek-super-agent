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
export interface RoutineSpec {
  /** Stable id, also the persisted last-run key. */
  id: string
  /** Interval in minutes. Bounded: at least 5 minutes, at most 7 days. */
  everyMinutes: number
  prompt: string
  /** Channel source the routine fires on. Default `cli`. */
  source: string
  /** Thread id inside that source. Default `local`. */
  thread: string
  /** Actor id the trigger carries. Default `you` (the CLI owner). */
  actor: string
  /**
   * Group id for `channel.address.group`. Needed when a group allowlist is
   * active, because admission rejects triggers without an address group.
   */
  group?: string
}

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
const SPEC_KEYS = new Set(['id', 'everyMinutes', 'prompt', 'source', 'thread', 'actor', 'group'])

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
  let content: string | undefined
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new UserError(`${ROUTINES_FILE} could not be read: ${messageOf(error)}`)
    }
  }
  let raw: unknown
  if (content !== undefined) {
    // A blank file means "no routines", and it suppresses the environment
    // seed: the file wins, including when the owner blanks it.
    if (!content.trim()) return []
    try {
      raw = JSON.parse(content)
    } catch (error) {
      throw new UserError(`${ROUTINES_FILE} is not valid JSON: ${messageOf(error)}`)
    }
  } else {
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

    const everyMinutes = raw.everyMinutes
    if (
      typeof everyMinutes !== 'number'
      || !Number.isInteger(everyMinutes)
      || everyMinutes < MIN_ROUTINE_MINUTES
      || everyMinutes > MAX_ROUTINE_MINUTES
    ) {
      throw new UserError(
        `routine ${id} everyMinutes must be an integer between ${MIN_ROUTINE_MINUTES} and ${MAX_ROUTINE_MINUTES}`,
      )
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
    const group = raw.group === undefined ? undefined : oneLine(raw.group, id, 'group', '')
    return {
      id,
      everyMinutes,
      prompt,
      source,
      thread,
      actor,
      ...(group ? { group } : {}),
    }
  })
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

  /** Check every routine once. Returns the ids whose ingestion was attempted. */
  tick(at = this.opts.now()): string[] {
    const fired: string[] = []
    for (const spec of this.specs) {
      // One corrupt last-run row, a clock anomaly, or a store error must not
      // escape this loop: an exception in the daemon timer would kill the
      // process, and skipping the try would also stop later routines.
      try {
        const last = this.opts.lastRun(spec.id)
        const interval = spec.everyMinutes * 60_000
        if (last === undefined) {
          this.opts.saveLastRun(spec.id, at)
          this.opts.log?.(`[routine] armed id=${spec.id} everyMinutes=${spec.everyMinutes}`)
          continue
        }
        if (typeof last !== 'number' || !Number.isFinite(last)) {
          this.opts.saveLastRun(spec.id, at)
          this.opts.log?.(`[routine] invalid lastRun id=${spec.id}; re-armed`)
          continue
        }
        if (at < last) {
          // A small backward step is usually NTP settling; keep the schedule.
          // A large one (bad RTC, restored snapshot) would otherwise stall the
          // routine until wall time re-reached the bogus value.
          if (last - at > Math.max(2 * interval, 10 * 60_000)) {
            this.opts.saveLastRun(spec.id, at)
            this.opts.log?.(`[routine] clock moved backwards id=${spec.id} by=${last - at}ms; re-armed`)
          } else {
            this.opts.log?.(`[routine] clock moved backwards id=${spec.id}; skipping`)
          }
          continue
        }
        if (at - last < interval) continue
        const due = last + interval
        if (!Number.isFinite(due)) {
          this.opts.saveLastRun(spec.id, at)
          this.opts.log?.(`[routine] invalid due slot id=${spec.id}; re-armed`)
          continue
        }
        const trigger = routineTrigger(spec, new Date(due).toISOString())
        fired.push(spec.id)
        this.opts.fire(trigger)
        this.opts.saveLastRun(spec.id, at)
        this.opts.log?.(`[routine] fired id=${spec.id} at=${trigger.at} source=${spec.source}`)
      } catch (error) {
        this.opts.log?.(`[routine] failed id=${spec.id}: ${messageOf(error)}`)
      }
    }
    return fired
  }
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
    channel: {
      source: spec.source,
      thread: spec.thread,
      ...(spec.group ? { address: { group: spec.group } } : {}),
    },
    meta: { routine: spec.id },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
