import fs from 'node:fs'
import path from 'node:path'
import { UserError } from '../shared/errors.ts'

/**
 * Owner-authored skills: a directory of playbooks the agent can load when a
 * task matches. The index (id plus one-line description) is injected into the
 * system prompt; the body is read on demand with `read_skill`.
 *
 * A skill is documentation, not a capability. It cannot grant a tool, widen a
 * role, or authorize an outward action. The registry only ever reads a regular
 * file inside `<home>/skills/<id>/SKILL.md`; symlinks and path-like ids are
 * rejected so a skill cannot become a arbitrary-file read.
 */
export interface SkillInfo {
  id: string
  description: string
}

export interface SkillRecord extends SkillInfo {
  /** Absolute path resolved at load time. Never exposed to the model. */
  file: string
  bytes: number
}

export interface SkillDocument extends SkillInfo {
  body: string
  truncated: boolean
}

export const SKILLS_DIR = 'skills'
export const SKILL_FILE = 'SKILL.md'
export const MAX_SKILLS = 64
/** Skip a skill file larger than this many bytes before reading it. */
export const MAX_SKILL_FILE_BYTES = 256_000
export const MAX_SKILL_BODY_CHARS = 16_000
export const MAX_SKILL_DESCRIPTION_CHARS = 200
/** Budget for the index lines in the prompt; extra skills stay on disk. */
export const MAX_SKILL_INDEX_CHARS = 2_000

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Read the owner's skills directory. Missing or empty means no skills, not an
 * error. A malformed skill is skipped with a warning so one bad file cannot
 * take down the agent.
 */
export function loadSkills(
  home: string,
  warn: (line: string) => void = () => {},
): SkillRecord[] {
  const root = path.join(home, SKILLS_DIR)
  let names: string[]
  try {
    names = fs.readdirSync(root).sort()
  } catch {
    return []
  }
  const skills: SkillRecord[] = []
  for (const name of names) {
    if (skills.length >= MAX_SKILLS) {
      warn(`[skill] stopping at ${MAX_SKILLS} skills; later entries are ignored`)
      break
    }
    if (!ID.test(name)) {
      warn(`[skill] skipping ${JSON.stringify(name)}: directory name must match ${ID}`)
      continue
    }
    const record = readSkillRecord(root, name, warn)
    if (record) skills.push(record)
  }
  return skills
}

function readSkillRecord(
  root: string,
  id: string,
  warn: (line: string) => void,
): SkillRecord | undefined {
  const dir = path.join(root, id)
  const file = path.join(dir, SKILL_FILE)
  try {
    if (!fs.lstatSync(dir).isDirectory()) {
      warn(`[skill] skipping ${id}: not a directory`)
      return undefined
    }
    // lstat, not stat: a symlink here could point outside the skills root.
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) {
      warn(`[skill] skipping ${id}: ${SKILL_FILE} must be a regular file, not a symlink`)
      return undefined
    }
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      warn(`[skill] skipping ${id}: ${SKILL_FILE} is larger than ${MAX_SKILL_FILE_BYTES} bytes`)
      return undefined
    }
    const parsed = parseSkill(fs.readFileSync(file, 'utf8'))
    if (!parsed) {
      warn(`[skill] skipping ${id}: missing or invalid frontmatter description`)
      return undefined
    }
    return { id, description: parsed.description, file, bytes: stat.size }
  } catch (error) {
    warn(`[skill] skipping ${id}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

interface ParsedSkill {
  description: string
  body: string
}

/** Parse the YAML-ish frontmatter these skills use: one `key: value` per line. */
export function parseSkill(text: string): ParsedSkill | undefined {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return undefined
  const header = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n+/, '').trimEnd()
  const meta: Record<string, string> = {}
  for (const line of header.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!
    const value = decodeScalar(match[2]!.trim())
    if (!(key in meta)) meta[key] = value
  }
  const description = meta.description?.trim() ?? ''
  if (!description || description.length > MAX_SKILL_DESCRIPTION_CHARS || /[\r\n]/.test(description)) {
    return undefined
  }
  return { description, body }
}

function decodeScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Read-only view of loaded skills. `list()` is prompt-safe; `read()` returns a
 * bounded body for one skill and re-checks the file before every read.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillRecord>()

  constructor(records: readonly SkillRecord[]) {
    for (const record of records) this.skills.set(record.id, record)
  }

  static fromHome(
    home: string,
    warn: (line: string) => void = () => {},
  ): SkillRegistry {
    return new SkillRegistry(loadSkills(home, warn))
  }

  list(): SkillInfo[] {
    return [...this.skills.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(skill => ({ id: skill.id, description: skill.description }))
  }

  get size(): number {
    return this.skills.size
  }

  read(id: string): SkillDocument {
    const skill = this.skills.get(id)
    if (!skill) {
      const available = this.list().map(item => item.id).join(', ') || 'none'
      throw new UserError(`unknown skill ${JSON.stringify(id)}; available: ${available}`)
    }
    const stat = fs.lstatSync(skill.file)
    if (!stat.isFile()) throw new UserError(`skill ${id} is no longer a regular file`)
    const parsed = parseSkill(fs.readFileSync(skill.file, 'utf8'))
    if (!parsed) throw new UserError(`skill ${id} changed on disk and is no longer valid`)
    const truncated = parsed.body.length > MAX_SKILL_BODY_CHARS
    return {
      id,
      description: parsed.description,
      body: truncated ? parsed.body.slice(0, MAX_SKILL_BODY_CHARS) : parsed.body,
      truncated,
    }
  }
}
