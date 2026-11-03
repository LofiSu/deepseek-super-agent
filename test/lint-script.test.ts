import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runLint, type Violation } from '../scripts/lint.ts'

const roots: string[] = []

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-lint-'))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

const board = (row: string): string => [
  '## 7. Dynamic task board',
  '',
  '| ID | Task | Owner | Branch | PR | Status | Acceptance |',
  '|----|------|-------|--------|----|--------|------------|',
  row,
  '',
  '## 8. Verification log',
  '',
].join('\n')

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function messages(violations: Violation[]): string[] {
  return violations.map(violation => `${violation.file}:${violation.line}: ${violation.message}`)
}

describe('lint script', () => {
  it('accepts a well-formed tree', () => {
    const root = fixture({
      'docs/ROADMAP.md': board('| P2-5 | Coverage + lint |  | `feat/x` | #1 | resolved | scripts exist |'),
      'README.md': 'No legacy extension switch.\n',
      'src/core/engine.ts': 'export const answer = 42\n',
      'src/cli/main.ts': 'console.log("ok")\n',
      'src/shared/log.ts': 'console.log("logger")\n',
    })
    const tracked = [
      'docs/ROADMAP.md',
      'README.md',
      'src/core/engine.ts',
      'src/cli/main.ts',
      'src/shared/log.ts',
    ]
    expect(runLint(root, tracked)).toEqual([])
  })

  it('reports a board row with the wrong cell count as file:line', () => {
    const root = fixture({
      'docs/ROADMAP.md': board('| P2-5 | Coverage |  | `feat/x` | #1 | resolved |'),
    })
    const violations = runLint(root, ['docs/ROADMAP.md'])
    expect(messages(violations)).toEqual([
      'docs/ROADMAP.md:5: board row has 6 cells, expected 7',
    ])
  })

  it('reports the board header and a row with too many cells', () => {
    const root = fixture({
      'docs/ROADMAP.md': [
        '## 7. Dynamic task board',
        '',
        '| ID | Task | Owner | Branch | PR | Status |',
        '|----|------|-------|--------|----|--------|',
        '| P2-5 | Coverage |  | `feat/x` | #1 | resolved | scripts exist | extra |',
        '',
      ].join('\n'),
    })
    const violations = runLint(root, ['docs/ROADMAP.md'])
    expect(messages(violations)).toEqual([
      'docs/ROADMAP.md:3: board header has 6 cells, expected 7 (ID | Task | Owner | Branch | PR | Status | Acceptance)',
      'docs/ROADMAP.md:5: board row has 8 cells, expected 7',
    ])
  })

  it('accepts escaped pipes inside a board cell', () => {
    const root = fixture({
      'docs/ROADMAP.md': board('| P2-5 | a \\| b |  | `feat/x` | #1 | resolved | ok |'),
    })
    expect(runLint(root, ['docs/ROADMAP.md'])).toEqual([])
  })

  it('reports live Phase-2 naming in src and docs but allows the historical audit', () => {
    const root = fixture({
      'docs/ROADMAP.md': board('| P2-5 | Coverage |  | `feat/x` | #1 | resolved | ok |'),
      'docs/notes.md': 'Phase-2 extensions are opt-in.\n',
      'src/phase2/shards.ts': 'export const shards = []\n',
      'README.md': 'The phase2 switch is gone.\n',
      'src/phase2/asset.png': 'binary-ish\n',
    })
    const tracked = [
      'docs/ROADMAP.md',
      'docs/notes.md',
      'src/phase2/shards.ts',
      'src/phase2/asset.png',
      'README.md',
    ]
    expect(messages(runLint(root, tracked))).toEqual([
      'docs/notes.md:1: Phase-2 naming: this tree is one M0-M11 whole; there is no Phase 2 switch or directory',
      'README.md:1: Phase-2 naming: this tree is one M0-M11 whole; there is no Phase 2 switch or directory',
      'src/phase2/asset.png:1: Phase-2 naming: this tree is one M0-M11 whole; there is no Phase 2 switch or directory',
      'src/phase2/shards.ts:1: Phase-2 naming: this tree is one M0-M11 whole; there is no Phase 2 switch or directory',
    ])
  })

  it('allows backticked roadmap history but rejects a new live Phase-2 claim', () => {
    const historical = [
      '## 7. Dynamic task board',
      '',
      '| ID | Task | Owner | Branch | PR | Status | Acceptance |',
      '|----|------|-------|--------|----|--------|------------|',
      '',
      '## 8. Verification log',
      '',
      'The switch `DS_AGENT_PHASE2` and `src/phase2/` are gone.',
      '',
    ].join('\n')
    const root = fixture({ 'docs/ROADMAP.md': historical })
    expect(runLint(root, ['docs/ROADMAP.md'])).toEqual([])

    fs.appendFileSync(path.join(root, 'docs/ROADMAP.md'), 'Phase-2 extension work is live again.\n')
    expect(messages(runLint(root, ['docs/ROADMAP.md']))).toEqual([
      'docs/ROADMAP.md:9: Phase-2 naming: this tree is one M0-M11 whole; there is no Phase 2 switch or directory',
    ])
  })

  it('ignores fenced examples and legend tables before the board header', () => {
    const root = fixture({
      'docs/ROADMAP.md': [
        '## 7. Dynamic task board',
        '',
        '| Legend | Meaning |',
        '|--------|---------|',
        '| P0 | urgent |',
        '',
        '```',
        '| a | b |',
        '```',
        '',
        '| ID | Task | Owner | Branch | PR | Status | Acceptance |',
        '|----|------|-------|--------|----|--------|------------|',
        '| P2-5 | Coverage |  | `feat/x` | #1 | resolved | ok |',
        '',
      ].join('\n'),
    })
    expect(runLint(root, ['docs/ROADMAP.md'])).toEqual([])
  })

  it('does not crash when a tracked file is missing from the working tree', () => {
    const root = fixture({
      'docs/ROADMAP.md': board('| P2-5 | Coverage |  | `feat/x` | #1 | resolved | ok |'),
    })
    expect(runLint(root, ['docs/ROADMAP.md', 'src/core/gone.ts'])).toEqual([])
  })

  it('reports tracked repro-h9, dist, and node_modules paths', () => {
    const root = fixture({
      'docs/ROADMAP.md': board('| P2-5 | Coverage |  | `feat/x` | #1 | resolved | ok |'),
    })
    const tracked = [
      'docs/ROADMAP.md',
      'repro-h9-debug.ts',
      'dist/cli.js',
      'node_modules/pkg/index.js',
    ]
    expect(messages(runLint(root, tracked))).toEqual([
      'dist/cli.js:1: generated path is tracked; dist/ and node_modules/ must stay untracked',
      'node_modules/pkg/index.js:1: generated path is tracked; dist/ and node_modules/ must stay untracked',
      'repro-h9-debug.ts:1: repro-h9 diagnostic is tracked; remove it or leave it untracked',
    ])
  })

  it('reports console usage outside src/cli/ but allows the shared Logger', () => {
    const root = fixture({
      'docs/ROADMAP.md': board('| P2-5 | Coverage |  | `feat/x` | #1 | resolved | ok |'),
      'src/core/engine.ts': [
        '// console.log("documented, not code")',
        'export function f(): void {',
        '  console.log("leak")',
        '  console["log"]("bracket")',
        '  const alias = console',
        '  alias.log("alias")',
        '}',
        '',
      ].join('\n'),
      'src/cli/main.ts': 'console.log("cli")\n',
      'src/shared/log.ts': 'console.log("logger")\n',
    })
    const tracked = ['docs/ROADMAP.md', 'src/core/engine.ts', 'src/cli/main.ts', 'src/shared/log.ts']
    expect(messages(runLint(root, tracked))).toEqual([
      'src/core/engine.ts:3: console usage outside src/cli/ (use the shared Logger or the CLI layer)',
      'src/core/engine.ts:4: console usage outside src/cli/ (use the shared Logger or the CLI layer)',
      'src/core/engine.ts:5: console usage outside src/cli/ (use the shared Logger or the CLI layer)',
    ])
  })
})
