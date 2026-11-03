import fs from 'node:fs'
import { gatewayConfigPath } from '../gateway/config-file.ts'
import { readConfig, wireConfig } from '../gateway/wiring.ts'
import { deleteProfile, listProfiles, loadProfile, saveProfile } from '../gateway/profiles.ts'

function valuesOf(name: string): string[] {
  const out: string[] = []
  process.argv.forEach((arg, index) => {
    if (arg === `--${name}` && process.argv[index + 1]) out.push(process.argv[index + 1]!)
  })
  return out
}

/** `ds-agent wire <file> --set KEY=VALUE [--set ...] [--env] [--format json|env]` */
export function runWireCommand(): void {
  const file = process.argv[3]
  if (!file || file.startsWith('--')) throw new Error('wire needs a config file: ds-agent wire <file> --set KEY=VALUE')
  const vars: Record<string, string> = {}
  for (const pair of valuesOf('set')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new Error(`--set expects KEY=VALUE, got "${pair}"`)
    vars[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  if (Object.keys(vars).length === 0) throw new Error('wire needs at least one --set KEY=VALUE')
  const format = valuesOf('format')[0] === 'json' ? 'json' : valuesOf('format')[0] === 'env' ? 'env' : undefined
  wireConfig(file, vars, { ...(format ? { format } : {}), envScope: process.argv.includes('--env') })
  console.log(`wired ${Object.keys(vars).length} key(s) into ${file}`)
}

/** `ds-agent profile list | save <name> | use <name> | rm <name>` */
export function runProfileCommand(home: string): void {
  const sub = process.argv[3]
  const name = process.argv[4]
  if (!sub || sub === 'list') {
    const profiles = listProfiles(home)
    if (profiles.length === 0) console.log('no profiles')
    for (const profile of profiles) console.log(`${profile.name}\t${profile.defaultModel ?? '-'}`)
    return
  }
  if (sub === 'save') {
    if (!name) throw new Error('profile save needs a name')
    const raw = readConfig(gatewayConfigPath(home))
    if (!raw || Object.keys(raw).length === 0) throw new Error(`no gateway config at ${gatewayConfigPath(home)}`)
    saveProfile(home, name, {
      providers: raw.providers,
      ...(raw.aliases ? { aliases: raw.aliases as Record<string, string[]> } : {}),
      ...(typeof raw.defaultModel === 'string' ? { defaultModel: raw.defaultModel } : {}),
      ...(typeof raw.masking === 'boolean' ? { masking: raw.masking } : {}),
    })
    console.log(`saved profile ${name}`)
    return
  }
  if (sub === 'use') {
    if (!name) throw new Error('profile use needs a name')
    const profile = loadProfile(home, name)
    if (!profile) throw new Error(`unknown profile ${name}`)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(gatewayConfigPath(home), `${JSON.stringify({
      ...(profile.providers !== undefined ? { providers: profile.providers } : {}),
      ...(profile.aliases ? { aliases: profile.aliases } : {}),
      ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
      ...(profile.masking !== undefined ? { masking: profile.masking } : {}),
    }, null, 2)}\n`)
    console.log(`applied profile ${name} to ${gatewayConfigPath(home)}`)
    return
  }
  if (sub === 'rm' || sub === 'delete') {
    if (!name) throw new Error('profile rm needs a name')
    console.log(deleteProfile(home, name) ? `removed profile ${name}` : `no profile ${name}`)
    return
  }
  throw new Error(`unknown profile subcommand ${sub} (list|save|use|rm)`)
}
