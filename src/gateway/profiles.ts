/**
 * Profiles: named snapshots of the gateway configuration (providers, aliases,
 * default model, masking), saved under `<stateDir>/gateway.profiles.json` and
 * applied by writing them back to `gateway.config.json` — Magpie's "Profiles"
 * for the gateway, in the generic, file-based sense.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface GatewayProfile {
  name: string
  providers?: unknown
  aliases?: Record<string, string[]>
  defaultModel?: string
  masking?: boolean
}

export function profilesPath(home: string): string {
  return path.join(home, 'gateway.profiles.json')
}

function readAll(home: string): Record<string, GatewayProfile> {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesPath(home), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, GatewayProfile> : {}
  } catch {
    return {}
  }
}

function writeAll(home: string, all: Record<string, GatewayProfile>): void {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(profilesPath(home), `${JSON.stringify(all, null, 2)}\n`)
}

export function saveProfile(home: string, name: string, profile: Omit<GatewayProfile, 'name'>): GatewayProfile {
  const all = readAll(home)
  const saved: GatewayProfile = { ...profile, name }
  all[name] = saved
  writeAll(home, all)
  return saved
}

export function listProfiles(home: string): GatewayProfile[] {
  return Object.values(readAll(home)).sort((left, right) => left.name.localeCompare(right.name))
}

export function loadProfile(home: string, name: string): GatewayProfile | undefined {
  return readAll(home)[name]
}

export function deleteProfile(home: string, name: string): boolean {
  const all = readAll(home)
  if (!all[name]) return false
  delete all[name]
  writeAll(home, all)
  return true
}
