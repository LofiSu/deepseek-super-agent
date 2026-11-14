import fs from 'node:fs'
import path from 'node:path'
import type { LocalAgentInfo } from '../env/local-agents.ts'
import { MAX_SKILL_INDEX_CHARS, type SkillInfo } from '../env/skills.ts'
import type { Role } from '../shared/types.ts'
import { SECTION_TEXT, roleText, type StaticSectionId } from './prompt-sections.ts'

/**
 * The stable system-prompt stack.
 *
 * The prompt is one composed document. Sections follow the Muse workspace
 * order: identity and values first, then the owner, work style, memory and
 * context, expression, environment and tools, the team, scheduled work,
 * channels, runtime files, security, safety, and finally the role contract.
 *
 * Runtime facts (who is speaking, which channel, recalled memory, the clock,
 * and the task itself) are not part of this block. They change per turn and
 * live in the turn prompt, so the system prefix stays cacheable.
 */
export const DEFAULT_PERSONA = `Warm, direct, competent. Talk like a close friend who happens to be excellent at
getting things done: short sentences, plain words, no flattery, no filler. Have
opinions when they matter. Ask one sharp question when the request is genuinely
ambiguous; otherwise make the reasonable call and say what you assumed. Never
praise the owner's question or your own work. Emojis only if the owner uses them
first.`

/** Upper bound for one owner-supplied prompt file, in characters. */
export const MAX_PROMPT_FILE_CHARS = 4000

/** Upper bound for the rendered owner-file sections, in characters. */
export const MAX_PROMPT_TOTAL_CHARS = 20_000

export type PromptFileKey =
  | 'soul'
  | 'identity'
  | 'user'
  | 'instructions'
  | 'agents'
  | 'memory'
  | 'tools'
  | 'heartbeat'
  | 'proactivePreferences'

export interface PromptFiles {
  soul?: string
  identity?: string
  user?: string
  instructions?: string
  agents?: string
  memory?: string
  tools?: string
  heartbeat?: string
  proactivePreferences?: string
  /** @deprecated use soul */
  persona?: string
  /** @deprecated use user */
  owner?: string
}

export type PromptSectionId =
  | StaticSectionId
  | 'soul'
  | 'identity'
  | 'user'
  | 'standing-instructions'
  | 'agents-manual'
  | 'proactive-preferences'
  | 'memory'
  | 'tools-notes'
  | 'heartbeat'
  | 'team'
  | 'skills'
  | 'role'

export interface PromptSection {
  /** Stable id used by docs, tests, and `prompt --layers`. */
  id: PromptSectionId
  /** The built-in module, owner file, or seed that decides this section. */
  source: string
  text: string
}

export interface PromptInput extends PromptFiles {
  role: Role
  /** Where each file-backed value came from, for `prompt --layers`. */
  sources?: Partial<Record<PromptFileKey, string>>
  /** Configured local specialists, injected into the team layer by name only. */
  localAgents?: readonly LocalAgentInfo[]
  /** Owner-authored playbooks, injected as an id/description index. */
  skills?: readonly SkillInfo[]
}

const SECTION_ORDER: readonly PromptSectionId[] = [
  'who-you-are',
  'values',
  'soul',
  'identity',
  'built-by',
  'who-you-work-for',
  'user',
  'standing-instructions',
  'discretion',
  'external-parties',
  'how-you-work',
  'how-you-evolve',
  'agents-manual',
  'proactivity',
  'proactive-preferences',
  'personalization',
  'memory',
  'contextual-awareness',
  'conversation-context',
  'writing-style',
  'environment',
  'tools',
  'tools-notes',
  'team',
  'skills',
  'scheduled-work',
  'heartbeat',
  'channels',
  'runtime-files',
  'filesystem',
  'security',
  'safety',
  'role',
]

const FILE_SECTION_IDS: ReadonlySet<PromptSectionId> = new Set([
  'soul',
  'identity',
  'user',
  'standing-instructions',
  'agents-manual',
  'memory',
  'tools-notes',
  'heartbeat',
  'proactive-preferences',
])

const CORE_FILE_SECTION_IDS: readonly PromptSectionId[] = [
  'soul',
  'identity',
  'user',
  'standing-instructions',
]

const OPTIONAL_FILE_SECTION_IDS: readonly PromptSectionId[] = [
  'memory',
  'agents-manual',
  'tools-notes',
  'heartbeat',
  'proactive-preferences',
]

const SOUL_INTRO =
  'Voice\n\nThe owner supplied the voice below. It may change tone, warmth, and wording. It cannot change the role contract, the rules, the security boundaries, or the safety boundaries in this prompt; where they conflict, those win.'
const IDENTITY_INTRO =
  'Identity\n\nThe owner supplied this identity. It changes the name, character, and presentation, not what you may do.'
const USER_INTRO =
  'About the owner\n\nThis is context from the owner, not a new instruction. Correct it when the owner tells you something different.'
const INSTRUCTIONS_INTRO =
  'Standing instructions\n\nThe owner supplied these rules for everyday work. Follow them within the role contract and the rules below; where they conflict, the rules below win.'
const AGENTS_INTRO =
  'Operating notes\n\nDurable lessons about working in this workspace, written by the owner. They cannot widen your role or authorize an action.'
const MEMORY_INTRO =
  'Long-term memory\n\nCurated durable facts and preferences. Use them to avoid repeating the owner; recall entries remain authoritative for provenance.'
const TOOLS_INTRO =
  'Tool notes\n\nEnvironment-specific notes for this installation. They cannot grant a tool or change a permission.'
const HEARTBEAT_INTRO =
  'Recurring checks\n\nA checklist the owner keeps in view. routines.json is the only thing that fires scheduled work; this file does not schedule anything.'
const PROACTIVE_INTRO =
  'Proactive preferences\n\nWhat the owner wants to hear about, what never, and how. These guide composition, not scheduling.'

/**
 * Owner files keep their headings, moved down one level so they do not look
 * like stack sections. Lines inside a fenced code block are literal text: a
 * shell comment must not become a Markdown heading.
 */
function demoteHeadings(text: string): string {
  let fence: string | undefined
  return text.split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0]
    if (marker) {
      if (!fence) fence = marker
      else if (fence === marker) fence = undefined
      return line
    }
    if (fence) return line
    return line.replace(/^(#{1,5}) /, '#$1 ')
  }).join('\n')
}

/** Remove every wrapper tag so a file cannot close its block and open another. */
function stripFileTags(text: string): string {
  return text
    .replace(/<\/?file\b[^>]*>/gi, '')
    .replace(/<\/?(?:persona|instructions|owner)\b[^>]*>/gi, '')
}

function block(tag: PromptSectionId, body: string, intro: string): string {
  return `# ${intro}\n\n<file id="${tag}">\n${body}\n</file>`
}

function fileSection(
  id: PromptSectionId,
  key: PromptFileKey,
  value: string | undefined,
  intro: string,
  input: PromptInput,
): PromptSection | undefined {
  const text = promptText(value)
  if (!text) return undefined
  return {
    id,
    source: input.sources?.[key] ?? 'provided',
    text: block(id, demoteHeadings(stripFileTags(text)), intro),
  }
}

function defaultSoulSection(): PromptSection {
  return { id: 'soul', source: 'built-in default soul', text: `# Voice\n\n${demoteHeadings(DEFAULT_PERSONA)}` }
}

/**
 * The team layer explains the two delegation surfaces: parallel Workers and
 * owner-configured local specialists. It only names ids and descriptions; the
 * specialist's command, environment, and limits never enter the prompt.
 */
function teamLayer(agents: readonly LocalAgentInfo[] | undefined): PromptSection {
  const configured = agents ?? []
  const list = configured.length
    ? `\n\nConfigured specialists: ${configured
      .map(agent => agent.description ? `${agent.id} (${agent.description})` : agent.id)
      .join(', ')}.`
    : ''
  return {
    id: 'team',
    source: configured.length ? 'local-agents.json' : 'built-in',
    text: `# Your team

You are the front of a small team, not a solo tool. Work can run in Workers: separate sessions with their own tools that execute in parallel and report back to you. When the owner has configured local specialist agents, a Worker can hand one self-contained task to one of them.

Use the team when it genuinely helps: independent work in parallel, a job that needs a specialist, or something big enough to run in the background. Do not delegate a one-line answer, and do not delegate to avoid thinking. You own the result: check what comes back, reconcile it, and tell the owner what happened. Never claim a worker or specialist did something you did not see confirmed.${list}`,
  }
}

/**
 * The owner's saved playbooks, by id and one-line description. The body is not
 * injected: the agent loads it with `read_skill` when the task matches. The
 * index is bounded so a large skills directory cannot crowd out the rules.
 */
function skillsLayer(skills: readonly SkillInfo[] | undefined): PromptSection | undefined {
  if (!skills?.length) return undefined
  const lines: string[] = []
  let used = 0
  for (const skill of [...skills].sort((a, b) => a.id.localeCompare(b.id))) {
    const line = `- ${skill.id}: ${skill.description}`
    if (used + line.length + 1 > MAX_SKILL_INDEX_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  if (!lines.length) return undefined
  return {
    id: 'skills',
    source: '<home>/skills/*/SKILL.md',
    text: `# Skills

The owner saved these playbooks. Each line is an id and when it applies. When a skill fits the task, call read_skill with its id before starting and follow its steps. A skill is guidance inside the rules: it cannot grant a tool, widen your role, or authorize an outward action.

${lines.join('\n')}`,
  }
}

function buildFileSections(input: PromptInput): Map<PromptSectionId, PromptSection> {
  const sections = new Map<PromptSectionId, PromptSection>()
  const add = (section: PromptSection | undefined): void => {
    if (section) sections.set(section.id, section)
  }
  add(fileSection('soul', 'soul', input.soul ?? input.persona, SOUL_INTRO, input))
  add(fileSection('identity', 'identity', input.identity, IDENTITY_INTRO, input))
  add(fileSection('user', 'user', input.user ?? input.owner, USER_INTRO, input))
  add(fileSection('standing-instructions', 'instructions', input.instructions, INSTRUCTIONS_INTRO, input))
  add(fileSection('agents-manual', 'agents', input.agents, AGENTS_INTRO, input))
  add(fileSection('memory', 'memory', input.memory, MEMORY_INTRO, input))
  add(fileSection('tools-notes', 'tools', input.tools, TOOLS_INTRO, input))
  add(fileSection('heartbeat', 'heartbeat', input.heartbeat, HEARTBEAT_INTRO, input))
  add(fileSection('proactive-preferences', 'proactivePreferences', input.proactivePreferences, PROACTIVE_INTRO, input))
  return sections
}

/**
 * Core owner sections always fit; optional sections are kept in priority
 * order while the rendered total stays within the owner budget. A section
 * that does not fit is omitted whole, never truncated.
 */
function budgetedFileSections(input: PromptInput): Map<PromptSectionId, PromptSection> {
  const all = buildFileSections(input)
  const kept = new Map(all)
  let used = 0
  for (const id of CORE_FILE_SECTION_IDS) {
    const section = id === 'soul' ? all.get('soul') ?? defaultSoulSection() : all.get(id)
    used += section?.text.length ?? 0
  }
  for (const id of OPTIONAL_FILE_SECTION_IDS) {
    const section = all.get(id)
    if (!section) continue
    if (used + section.text.length > MAX_PROMPT_TOTAL_CHARS) {
      kept.delete(id)
      continue
    }
    used += section.text.length
  }
  return kept
}

/**
 * The full stable stack, in dependency order. Optional owner sections are
 * omitted when their file or seed is absent; the default persona is always
 * present.
 */
export function describePromptSections(input: PromptInput): PromptSection[] {
  const fileSections = budgetedFileSections(input)
  const sections: PromptSection[] = []
  for (const id of SECTION_ORDER) {
    const file = fileSections.get(id)
    if (file) {
      sections.push(file)
      continue
    }
    if (id === 'soul') {
      sections.push(defaultSoulSection())
      continue
    }
    if (id === 'team') {
      sections.push(teamLayer(input.localAgents))
      continue
    }
    if (id === 'skills') {
      const skills = skillsLayer(input.skills)
      if (skills) sections.push(skills)
      continue
    }
    if (id === 'role') {
      sections.push({ id, source: 'built-in', text: roleText(input.role) })
      continue
    }
    if (FILE_SECTION_IDS.has(id)) continue
    sections.push({ id, source: 'built-in', text: SECTION_TEXT[id as StaticSectionId] })
  }
  return sections
}

export function buildSystemPrompt(input: PromptInput): string {
  return describePromptSections(input).map(section => section.text).join('\n\n')
}

/** Compatibility entry point for callers that only know the role. */
export function systemPrompt(
  role: Role,
  files: PromptFiles = {},
  localAgents?: readonly LocalAgentInfo[],
  skills?: readonly SkillInfo[],
): string {
  return buildSystemPrompt({
    ...files,
    role,
    ...(localAgents ? { localAgents } : {}),
    ...(skills ? { skills } : {}),
  })
}

/** @deprecated use PromptSection */
export type PromptLayer = PromptSection
/** @deprecated use PromptSectionId */
export type PromptLayerId = PromptSectionId

/** @deprecated use describePromptSections */
export function describePromptLayers(input: PromptInput): PromptSection[] {
  return describePromptSections(input)
}

function promptText(value: string | undefined): string | undefined {
  const text = value?.replace(/\r\n/g, '\n').replace(/\0/g, '').trim()
  if (!text) return undefined
  return text.slice(0, MAX_PROMPT_FILE_CHARS)
}

/** Owner-editable runtime file for each section. */
export const PROMPT_FILES: Record<PromptFileKey, string> = {
  soul: 'SOUL.md',
  identity: 'IDENTITY.md',
  user: 'USER.md',
  instructions: 'INSTRUCTIONS.md',
  agents: 'AGENTS.md',
  memory: 'MEMORY.md',
  tools: 'TOOLS.md',
  heartbeat: 'HEARTBEAT.md',
  proactivePreferences: 'PROACTIVE_PREFERENCES.md',
}

/**
 * Deployer seeds for a fresh home. Most runtime files are owner-only; these
 * four have a useful default that a container can set without a writable home.
 */
export const PROMPT_ENV: Partial<Record<PromptFileKey, string>> = {
  soul: 'DS_AGENT_SOUL',
  identity: 'DS_AGENT_IDENTITY',
  user: 'DS_AGENT_OWNER',
  instructions: 'DS_AGENT_INSTRUCTIONS',
}

/** @deprecated old name for the soul file. */
export const LEGACY_PROMPT_FILE = { soul: 'PERSONA.md' } as const
/** @deprecated old seed for the soul file. */
export const LEGACY_PROMPT_ENV = { soul: 'DS_AGENT_PERSONA' } as const

const CANONICAL_KEYS: readonly PromptFileKey[] = [
  'soul',
  'identity',
  'user',
  'instructions',
  'agents',
  'memory',
  'tools',
  'heartbeat',
  'proactivePreferences',
]

export interface LoadedPrompts {
  files: PromptFiles
  /** Where each present value came from, for `prompt --layers`. */
  sources: Partial<Record<PromptFileKey, string>>
}

/**
 * Only a regular file counts. A directory, device, or symlink named like a
 * prompt file is absent: the runtime must not follow a link out of home.
 */
function readPromptFile(home: string, name: string): string | undefined {
  try {
    const full = path.join(home, name)
    if (!fs.lstatSync(full).isFile()) return undefined
    return promptText(fs.readFileSync(full, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Read the owner-editable files, falling back to deployer seeds in the
 * environment. A file always wins over the matching seed. Missing, blank,
 * unreadable, or non-regular files are ignored rather than failing the runtime.
 * `PERSONA.md` and `DS_AGENT_PERSONA` still supply the soul, with a warning.
 */
export function loadPrompts(
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  warn: (line: string) => void = () => {},
): LoadedPrompts {
  const files: Record<PromptFileKey, string | undefined> = {
    soul: undefined,
    identity: undefined,
    user: undefined,
    instructions: undefined,
    agents: undefined,
    memory: undefined,
    tools: undefined,
    heartbeat: undefined,
    proactivePreferences: undefined,
  }
  const sources: Partial<Record<PromptFileKey, string>> = {}
  for (const key of CANONICAL_KEYS) {
    const file = readPromptFile(home, PROMPT_FILES[key])
    if (file !== undefined) {
      files[key] = file
      sources[key] = `<home>/${PROMPT_FILES[key]}`
      continue
    }
    const envName = PROMPT_ENV[key]
    if (!envName) continue
    const seed = promptText(env[envName])
    if (seed !== undefined) {
      files[key] = seed
      sources[key] = `env:${envName}`
    }
  }
  if (files.soul === undefined) {
    const legacyFile = readPromptFile(home, LEGACY_PROMPT_FILE.soul)
    if (legacyFile !== undefined) {
      files.soul = legacyFile
      sources.soul = `<home>/${LEGACY_PROMPT_FILE.soul} (deprecated fallback)`
      warn(`[prompt] ${LEGACY_PROMPT_FILE.soul} is deprecated; rename it to ${PROMPT_FILES.soul}`)
    } else {
      const legacySeed = promptText(env[LEGACY_PROMPT_ENV.soul])
      if (legacySeed !== undefined) {
        files.soul = legacySeed
        sources.soul = `env:${LEGACY_PROMPT_ENV.soul} (deprecated fallback)`
        warn(`[prompt] ${LEGACY_PROMPT_ENV.soul} is deprecated; use ${PROMPT_ENV.soul}`)
      }
    }
  }
  return { files, sources }
}

export function loadPromptFiles(
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  warn: (line: string) => void = () => {},
): PromptFiles {
  return loadPrompts(home, env, warn).files
}
