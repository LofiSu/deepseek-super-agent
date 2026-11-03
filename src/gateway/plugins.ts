/**
 * Gateway plugin runtime (mirrors Magpie's gateway middleware + router-strategy
 * extension points, in TypeScript).
 *
 * A plugin is a module exporting a default object with any of:
 * - `onRequest(body, ctx)`  — transform an agent's request body before routing
 * - `onResponse(body, ctx)` — transform a whole (non-streamed) reply body
 * - `strategies`            — `{ name: (seats, options) => order }` router strategies
 *
 * Hooks fail open: a throw, a non-object return, or exceeding the time limit
 * leaves the body as it was (as Magpie documents). Plugins load from
 * `<home>/gateway-plugins/*.mjs|*.js`, enabled by `<home>/gateway.plugins.json`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export type JsonObject = Record<string, unknown>

export interface PluginCtx {
  protocol: string
  model?: string
  status?: number
  options: JsonObject
  /** Shared across a request's hooks (so onRequest state is visible to onResponse). */
  state: Record<string, unknown>
}

export interface RouteSeat {
  index: number
  provider: string
  model: string
  priority: number
  cooling: boolean
  /** Relative provider cost, lower = cheaper (for the `free` strategy). */
  cost?: number
  /** Requests seen for this provider (for the `usage` strategy). */
  requests?: number
  /** Observed average latency in ms (for the `fast` strategy). */
  avgLatencyMs?: number
  /** Tokens used today (for the `pace` strategy). */
  tokensToday?: number
  /** Daily token budget (for the `pace` strategy). */
  dailyTokens?: number
}

export type StrategyFn = (seats: RouteSeat[], options: JsonObject) => number[]

export interface GatewayPlugin {
  id: string
  onRequest?: (body: JsonObject, ctx: PluginCtx) => JsonObject | undefined | Promise<JsonObject | undefined>
  onResponse?: (body: JsonObject, ctx: PluginCtx) => JsonObject | undefined | Promise<JsonObject | undefined>
  strategies?: Record<string, StrategyFn>
  /** Fire-and-forget usage hook (mirrors Magpie's onUsage). */
  onUsage?: (row: JsonObject, ctx: PluginCtx) => void | Promise<void>
}

export interface PluginEntry {
  id: string
  enabled?: boolean
  options?: JsonObject
}

export interface PluginFile {
  plugins?: PluginEntry[]
}

const HOOK_TIMEOUT_MS = 250

function timed<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('plugin hook timed out')), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

export class PluginHost {
  private readonly entries: Array<{ plugin: GatewayPlugin; options: JsonObject }> = []

  register(plugin: GatewayPlugin, options: JsonObject = {}): void {
    if (!plugin || typeof plugin.id !== 'string') throw new Error('plugin needs an id')
    if (this.entries.some(entry => entry.plugin.id === plugin.id)) return
    this.entries.push({ plugin, options })
  }

  /** Load plugins from a directory; a config file, when present, selects which are on. */
  async loadFromDir(dir: string, configPath?: string): Promise<string[]> {
    const enabled = new Map<string, JsonObject>()
    let hasConfig = false
    if (configPath) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as PluginFile
        for (const entry of config.plugins ?? []) {
          if (entry.enabled !== false) enabled.set(entry.id, entry.options ?? {})
        }
        hasConfig = true
      } catch {
        // Missing/invalid config: treat the directory as fully enabled.
      }
    }
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter(file => /\.(mjs|js)$/.test(file))
    } catch {
      return []
    }
    const loaded: string[] = []
    for (const file of files) {
      const id = file.replace(/\.(mjs|js)$/, '')
      if (hasConfig && !enabled.has(id)) continue
      try {
        const url = pathToFileURL(path.join(dir, file)).href
        const mod = await import(/* @vite-ignore */ url) as GatewayPlugin & { default?: GatewayPlugin }
        const plugin = (mod.default ?? mod) as GatewayPlugin
        if (!plugin || typeof plugin.id !== 'string') continue
        this.register(plugin, enabled.get(id) ?? {})
        loaded.push(plugin.id)
      } catch {
        // A broken plugin must not break the gateway.
      }
    }
    return loaded
  }

  list(): string[] {
    return this.entries.map(entry => entry.plugin.id)
  }

  /** All router strategies contributed by plugins (later duplicate names lose). */
  strategies(): Record<string, StrategyFn> {
    const out: Record<string, StrategyFn> = {}
    for (const { plugin, options } of this.entries) {
      for (const [name, fn] of Object.entries(plugin.strategies ?? {})) {
        out[name] = (seats: RouteSeat[]) => fn(seats, options)
      }
    }
    return out
  }

  async runRequest(body: JsonObject, base: { protocol: string; model?: string }, state: Record<string, unknown>): Promise<JsonObject> {
    let current = body
    for (const { plugin, options } of this.entries) {
      if (!plugin.onRequest) continue
      try {
        const out = await timed(Promise.resolve(plugin.onRequest(current, { ...base, options, state })), HOOK_TIMEOUT_MS)
        if (out && typeof out === 'object') current = out
      } catch {
        // Fail open.
      }
    }
    return current
  }

  async runResponse(
    body: JsonObject,
    base: { protocol: string; model?: string; status?: number },
    state: Record<string, unknown>,
  ): Promise<JsonObject> {
    let current = body
    for (const { plugin, options } of this.entries) {
      if (!plugin.onResponse) continue
      try {
        const out = await timed(Promise.resolve(plugin.onResponse(current, { ...base, options, state })), HOOK_TIMEOUT_MS)
        if (out && typeof out === 'object') current = out
      } catch {
        // Fail open.
      }
    }
    return current
  }

  /** Fire-and-forget usage hook. Fail open; a returned promise is not awaited. */
  runUsage(row: JsonObject): void {
    for (const { plugin, options } of this.entries) {
      if (!plugin.onUsage) continue
      try {
        const out = plugin.onUsage(row, { protocol: '', options, state: {} })
        if (out && typeof (out as Promise<void>).then === 'function') void (out as Promise<void>).catch(() => undefined)
      } catch {
        // Fail open.
      }
    }
  }
}
