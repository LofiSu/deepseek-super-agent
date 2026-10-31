import fs from 'node:fs'
import path from 'node:path'

/** External secret store. Values must never appear in tool results or prompts. */
export interface Vault {
  has(name: string): boolean
  /** Names only — never returns values to callers that build model context. */
  names(): string[]
  describe(): { name: string; present: boolean }[]
  set(name: string, value: string): void
  /** Inject selected secrets into a child process env. Do not log the result. */
  resolveForChild(names: readonly string[]): NodeJS.ProcessEnv
}

export class MemoryVault implements Vault {
  readonly #secrets = new Map<string, string>()

  has(name: string): boolean {
    return this.#secrets.has(name)
  }

  names(): string[] {
    return [...this.#secrets.keys()].sort()
  }

  describe(): { name: string; present: boolean }[] {
    return this.names().map(name => ({ name, present: true }))
  }

  set(name: string, value: string): void {
    if (!name.trim()) throw new Error('vault name required')
    this.#secrets.set(name, value)
  }

  resolveForChild(names: readonly string[]): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {}
    for (const name of names) {
      const value = this.#secrets.get(name)
      if (value !== undefined) out[name] = value
    }
    return out
  }
}

export class FileVault implements Vault {
  readonly #mem = new MemoryVault()

  constructor(private readonly filePath: string) {
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string>
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') this.#mem.set(k, v)
      }
    } catch {
      // empty vault
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const obj: Record<string, string> = {}
    for (const name of this.#mem.names()) {
      const child = this.#mem.resolveForChild([name])
      if (child[name] !== undefined) obj[name] = child[name]!
    }
    fs.writeFileSync(this.filePath, `${JSON.stringify(obj)}\n`, { mode: 0o600 })
    fs.chmodSync(this.filePath, 0o600)
  }

  has(name: string): boolean {
    return this.#mem.has(name)
  }

  names(): string[] {
    return this.#mem.names()
  }

  describe(): { name: string; present: boolean }[] {
    return this.#mem.describe()
  }

  set(name: string, value: string): void {
    this.#mem.set(name, value)
    this.persist()
  }

  resolveForChild(names: readonly string[]): NodeJS.ProcessEnv {
    return this.#mem.resolveForChild(names)
  }
}
