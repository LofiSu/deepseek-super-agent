/**
 * Repo-specific lint checks. Deterministic, read-only, and fast.
 *
 * Run with `pnpm lint` (tsx). Every violation prints `file:line: message` and
 * the process exits 1.
 *
 * Rules:
 *  - docs/ROADMAP.md section 7 board rows have exactly 7 cells.
 *  - No live Phase-2 naming in src/, docs/, or the READMEs. The historical
 *    audit in docs/ROADMAP.md is exempt: it quotes the removed switch while
 *    recording that the switch is gone.
 *  - No tracked repro-h9* diagnostics and no tracked dist/ or node_modules/
 *    paths.
 *  - No console.log under src/ outside src/cli/. src/shared/log.ts is the
 *    Logger that deliberately writes to stdout, so it is exempt.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface Violation {
  file: string
  line: number
  message: string
}

const ROADMAP_FILE = 'docs/ROADMAP.md'
const BOARD_HEADING = '## 7. Dynamic task board'
const BOARD_COLUMNS = 7
const PHASE2_PATTERN = /\bphase(?:\s*-\s*|\s*)?2\b/i
const PHASE2_HISTORY_ALLOWLIST = new Set([ROADMAP_FILE])
const CONSOLE_LOG_ALLOWLIST = new Set(['src/shared/log.ts'])
const TEXT_FILE = /\.(?:ts|tsx|md|json)$/

export function findRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

export function listTrackedFiles(root: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  return output.split('\0').filter(Boolean).sort()
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

function readLineViolations(
  root: string,
  files: readonly string[],
  test: (file: string) => boolean,
  pattern: RegExp,
  message: string,
): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    if (!test(file)) continue
    const content = fs.readFileSync(path.join(root, file), 'utf8')
    for (const match of content.matchAll(pattern)) {
      violations.push({ file, line: lineOf(content, match.index ?? 0), message })
    }
  }
  return violations
}

function splitBoardRow(rawLine: string): string[] {
  const line = rawLine.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '\\' && line[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

function isSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/gu, '')))
}

export function checkRoadmapBoard(root: string): Violation[] {
  const absolute = path.join(root, ROADMAP_FILE)
  if (!fs.existsSync(absolute)) {
    return [{ file: ROADMAP_FILE, line: 1, message: `missing ${ROADMAP_FILE}` }]
  }
  const lines = fs.readFileSync(absolute, 'utf8').split('\n')
  const start = lines.findIndex(line => line.trim() === BOARD_HEADING)
  if (start === -1) {
    return [{ file: ROADMAP_FILE, line: 1, message: `missing "${BOARD_HEADING}" section` }]
  }

  const violations: Violation[] = []
  let headerSeen = false
  for (let index = start + 1; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.startsWith('## ')) break
    const trimmed = raw.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = splitBoardRow(trimmed)
    if (!headerSeen) {
      headerSeen = true
      if (cells.length !== BOARD_COLUMNS || cells[0] !== 'ID' || cells[1] !== 'Task') {
        violations.push({
          file: ROADMAP_FILE,
          line: index + 1,
          message: `board header has ${cells.length} cells, expected ${BOARD_COLUMNS} (ID | Task | Owner | Branch | PR | Status | Acceptance)`,
        })
      }
      continue
    }
    if (isSeparator(cells)) continue
    if (cells.length !== BOARD_COLUMNS) {
      violations.push({
        file: ROADMAP_FILE,
        line: index + 1,
        message: `board row has ${cells.length} cells, expected ${BOARD_COLUMNS}`,
      })
    }
  }
  if (!headerSeen) {
    violations.push({ file: ROADMAP_FILE, line: start + 1, message: 'board table header not found' })
  }
  return violations
}

export function checkPhaseNaming(root: string, tracked: readonly string[]): Violation[] {
  const inScope = (file: string): boolean => {
    if (PHASE2_HISTORY_ALLOWLIST.has(file)) return false
    if (!TEXT_FILE.test(file)) return false
    if (file === 'README.md' || file === 'README.zh-CN.md') return true
    return file.startsWith('src/') || file.startsWith('docs/')
  }
  const message = 'Phase-2 naming: this tree is one M0-M11 whole; there is no Phase 2 switch or directory'
  const violations: Violation[] = []
  const seen = new Set<string>()
  const add = (file: string, line: number): void => {
    const key = `${file}:${line}:${message}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push({ file, line, message })
  }
  for (const file of tracked) {
    if (!inScope(file)) continue
    if (PHASE2_PATTERN.test(file)) add(file, 1)
    const content = fs.readFileSync(path.join(root, file), 'utf8')
    for (const match of content.matchAll(new RegExp(PHASE2_PATTERN.source, 'giu'))) {
      add(file, lineOf(content, match.index ?? 0))
    }
  }
  return violations
}

export function checkRepoHygiene(tracked: readonly string[]): Violation[] {
  const violations: Violation[] = []
  for (const file of tracked) {
    const segments = file.split('/')
    if (segments.includes('dist') || segments.includes('node_modules')) {
      violations.push({
        file,
        line: 1,
        message: 'generated path is tracked; dist/ and node_modules/ must stay untracked',
      })
    }
    if (/^repro-h9/u.test(path.posix.basename(file))) {
      violations.push({
        file,
        line: 1,
        message: 'repro-h9 diagnostic is tracked; remove it or leave it untracked',
      })
    }
  }
  return violations
}

export function checkConsoleLog(root: string, tracked: readonly string[]): Violation[] {
  return readLineViolations(
    root,
    tracked,
    file => file.startsWith('src/')
      && file.endsWith('.ts')
      && !file.startsWith('src/cli/')
      && !CONSOLE_LOG_ALLOWLIST.has(file),
    /\bconsole\.log\s*\(/gu,
    'console.log outside src/cli/ (use the shared Logger or the CLI layer)',
  )
}

export function runLint(root: string, tracked: readonly string[] = listTrackedFiles(root)): Violation[] {
  const violations = [
    ...checkRoadmapBoard(root),
    ...checkPhaseNaming(root, tracked),
    ...checkRepoHygiene(tracked),
    ...checkConsoleLog(root, tracked),
  ]
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.message.localeCompare(b.message))
}

function main(): void {
  const root = findRepoRoot()
  const tracked = listTrackedFiles(root)
  const violations = runLint(root, tracked)
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line}: ${violation.message}`)
    }
    console.error(`lint: ${violations.length} violation(s) across ${tracked.length} tracked files`)
    process.exitCode = 1
    return
  }
  console.log(`lint ok (${tracked.length} tracked files)`)
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) main()
