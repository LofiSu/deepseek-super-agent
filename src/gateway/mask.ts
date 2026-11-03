/**
 * Privacy masking as a gateway plugin (mirrors Magpie's `redact` plugin):
 * `onRequest` replaces secrets/personal data with deterministic `{{KIND_hash}}`
 * placeholders before the request leaves this machine; `onResponse` puts the
 * real values back in the reply. Placeholders are stable per value, so prompt
 * caching is not broken.
 */

import type { GatewayPlugin, JsonObject } from './plugins.ts'

const RULES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'API_KEY', re: /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/g },
  { name: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'TOKEN', re: /\b[A-Fa-f0-9]{32,}\b/g },
]

function shortHash(value: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export class Masker {
  private readonly byValue = new Map<string, string>()
  private readonly byPlaceholder = new Map<string, string>()

  mask(text: string): string {
    let out = text
    for (const rule of RULES) out = out.replace(rule.re, match => this.placeholder(rule.name, match))
    return out
  }

  unmask(text: string): string {
    let out = text
    for (const [placeholder, value] of this.byPlaceholder) out = out.split(placeholder).join(value)
    return out
  }

  private placeholder(kind: string, value: string): string {
    const existing = this.byValue.get(value)
    if (existing) return existing
    const placeholder = `{{${kind}_${shortHash(value)}}}`
    this.byValue.set(value, placeholder)
    this.byPlaceholder.set(placeholder, value)
    return placeholder
  }
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map(item => mapStrings(item, fn))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = mapStrings(inner, fn)
    return out
  }
  return value
}

export function maskingPlugin(): GatewayPlugin {
  return {
    id: 'redact',
    onRequest(body, ctx) {
      const masker = new Masker()
      ctx.state.masker = masker
      return mapStrings(body, text => masker.mask(text)) as JsonObject
    },
    onResponse(body, ctx) {
      const masker = ctx.state.masker
      if (!(masker instanceof Masker)) return body
      return mapStrings(body, text => masker.unmask(text)) as JsonObject
    },
  }
}
