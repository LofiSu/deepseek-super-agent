/**
 * Repo-specific lint checks. Deterministic, read-only, and fast.
 *
 * Run with `pnpm lint` (tsx). Every violation prints `file:line: message` and
 * the process exits 1.
 *
 * Rules:
 *  - docs/ROADMAP.md section 7 board rows have exactly 7 cells.
 *  - No live Phase-2 naming in src/, docs/, or the READMEs. Path names are
 *    checked for every tracked file. In docs/ROADMAP.md, inline-code citations
 *    of the removed switch (e.g. `src/phase2`, `DS_AGENT_PHASE2`) and the one
 *    line that describes this rule are allowed; a live "Phase-2" claim is not.
 *  - No tracked repro-h9* diagnostics and no tracked dist/ or node_modules/
 *    paths.
 *  - No `console` usage under src/ outside src/cli/. src/shared/log.ts is the
 *    Logger that deliberately writes to stdout, so it is exempt. Comments and
 *    strings are ignored because this uses the TypeScript AST.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export interface Violation {
  file: string
  line: number
  message: string
}

const ROADMAP_FILE = 'docs/ROADMAP.md'
const BOARD_HEADING = '## 7. Dynamic task board'
const BOARD_COLUMNS = 7
const PHASE2_PATTERN = /\bphase(?:\s*-\s*|\s*)?2\b/i
const PHASE2_RULE_DESCRIPTION = /no live Phase-2 naming/i
// The exemption is limited to the paragraph that documents the rule itself;
// an arbitrary sentence that merely quotes the phrase must still fail.
const PHASE2_RULE_CONTEXT = /inline-code citations|documenting the rule|historical audit/i
const INLINE_CODE = /`[^`]*`/gu
const CONSOLE_ALLOWLIST = new Set(['src/shared/log.ts'])
const TEXT_FILE = /\.(?:ts|tsx|md|json)$/

export function findRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

export function listTrackedFiles(root: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  return output.split('\0').filter(Boolean).sort()
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
  let inFence = false
  let headerIndex = -1
  let separatorSeen = false
  for (let index = start + 1; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.startsWith('## ')) break
    // A fenced example is not the board, even when it contains a pipe.
    if (/^\s*(?:```|~~~)/u.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const trimmed = raw.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = splitBoardRow(trimmed)
    if (headerIndex === -1) {
      // Ignore legend/other tables: only a row starting with ID is the board
      // header. A wrong shape is reported so the table cannot silently pass.
      if (cells[0] === 'ID') {
        headerIndex = index
        if (cells.length !== BOARD_COLUMNS) {
          violations.push({
            file: ROADMAP_FILE,
            line: index + 1,
            message: `board header has ${cells.length} cells, expected ${BOARD_COLUMNS} (ID | Task | Owner | Branch | PR | Status | Acceptance)`,
          })
        } else if (cells[1] !== 'Task') {
          violations.push({
            file: ROADMAP_FILE,
            line: index + 1,
            message: `board header second cell is "${cells[1]}", expected "Task"`,
          })
        }
      }
      continue
    }
    if (!separatorSeen) {
      // The separator belongs to the header; a non-separator pipe line is still
      // checked as a row so malformed tables are reported.
      if (isSeparator(cells)) {
        separatorSeen = true
        if (cells.length !== BOARD_COLUMNS) {
          violations.push({
            file: ROADMAP_FILE,
            line: index + 1,
            message: `board separator has ${cells.length} cells, expected ${BOARD_COLUMNS}`,
          })
        }
        continue
      }
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
  if (headerIndex === -1) {
    violations.push({ file: ROADMAP_FILE, line: start + 1, message: 'board table header not found' })
  } else if (!separatorSeen) {
    violations.push({
      file: ROADMAP_FILE,
      line: headerIndex + 1,
      message: `board header has no separator row (${BOARD_COLUMNS} columns expected)`,
    })
  }
  return violations
}

export function checkPhaseNaming(root: string, tracked: readonly string[]): Violation[] {
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
    // Paths are checked for every tracked file, including binaries and assets.
    if (PHASE2_PATTERN.test(file)) add(file, 1)
    const contentScope = file === 'README.md'
      || file === 'README.zh-CN.md'
      || file.startsWith('src/')
      || file.startsWith('docs/')
    if (!contentScope || !TEXT_FILE.test(file)) continue
    const absolute = path.join(root, file)
    if (!fs.existsSync(absolute)) continue
    const lines = fs.readFileSync(absolute, 'utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!PHASE2_PATTERN.test(line)) continue
      // The roadmap is the audit record. Inline-code citations of the removed
      // switch and the line that documents this rule are history, not a new
      // live claim; plain "Phase-2" prose is still rejected.
      if (file === ROADMAP_FILE) {
        const ruleLine = PHASE2_RULE_DESCRIPTION.test(line) && PHASE2_RULE_CONTEXT.test(line)
        if (ruleLine || !PHASE2_PATTERN.test(line.replace(INLINE_CODE, ''))) {
          continue
        }
      }
      add(file, index + 1)
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
  const violations: Violation[] = []
  for (const file of tracked) {
    if (!file.startsWith('src/') || !file.endsWith('.ts')) continue
    if (file.startsWith('src/cli/') || CONSOLE_ALLOWLIST.has(file)) continue
    const absolute = path.join(root, file)
    if (!fs.existsSync(absolute)) continue
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      // Any `console` identifier catches console.log, console['log'],
      // console.log?.(), and `const l = console.log` aliases. Comments and
      // strings are not identifiers, so documentation examples stay clean.
      const report = (at: ts.Node): void => {
        const { line } = source.getLineAndCharacterOfPosition(at.getStart(source))
        violations.push({
          file,
          line: line + 1,
          message: 'console usage outside src/cli/ (use the shared Logger or the CLI layer)',
        })
      }
      if (ts.isIdentifier(node) && node.text === 'console') {
        report(node)
        return
      }
      // `globalThis["console"]` (optionally cast) is the same escape hatch with a
      // string argument, so it is not an Identifier node.
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        const globalBase = (raw: ts.Expression): boolean => {
          if (ts.isIdentifier(raw)) return raw.text === 'globalThis'
          if (ts.isAsExpression(raw) || ts.isParenthesizedExpression(raw)) {
            return globalBase(raw.expression)
          }
          return false
        }
        if (globalBase(node.expression) && node.argumentExpression.text === 'console') {
          report(node)
          return
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return violations
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
