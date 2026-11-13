import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeEvaluatorDigest } from '../src/evolution/evaluator-identity.ts'
import type { DeliverGateStrategyV1, EvolutionEvalCase } from '../src/evolution/types.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The evaluator child now resolves source vs dist artifacts, which changes its
// bytes and therefore the digest. The other three hashed files are unchanged;
// see the report for the old-to-new digest check.
const SOURCE_EVALUATOR_DIGEST = '180ab65e579752c5e784c1b3866e36a8147b21dd5647ebc6031267fc75c28500'

interface EvaluatorArtifacts {
  repoRoot: string
  score: string
  strategyGate: string
  safePattern: string
  childScript: string
}

interface EvaluatorIdentityModule {
  computeEvaluatorDigest(): string
}

interface IsolateEvalModule {
  evalChildArgs(
    paths: { strategyPath: string; splitPath: string; splitName: string },
    hasTsxCli?: boolean,
  ): string[]
  isolatedEvaluateSplit(
    workDir: string,
    strategy: DeliverGateStrategyV1,
    splitName: 'train' | 'validation' | 'finaltest',
    cases: EvolutionEvalCase[],
    budget: { evalTimeoutMs: number },
  ): Promise<{ ok: boolean; score?: { accuracy: number }; error?: string }>
}

const tempDirs: string[] = []
let publishedRoot = ''

function makeTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeFiles(base: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(base, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, 'utf8')
  }
}

function runBuild(): void {
  const result = spawnSync('pnpm', ['build'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  if (result.status !== 0) {
    throw new Error(`pnpm build failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
}

/** Copy only package.json plus the `files` whitelist into a fresh tree. */
function assemblePublishedTree(target: string): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { files: string[] }
  fs.copyFileSync(path.join(root, 'package.json'), path.join(target, 'package.json'))
  for (const entry of pkg.files) {
    const from = path.join(root, entry)
    const to = path.join(target, entry)
    if (!fs.existsSync(from)) throw new Error(`missing whitelisted file: ${entry}`)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(from, to, { recursive: true })
  }
}

async function importPublished<T>(relative: string): Promise<T> {
  const url = pathToFileURL(path.join(publishedRoot, relative)).href
  return (await import(/* @vite-ignore */ url)) as T
}

async function loadResolver(): Promise<(moduleDir?: string) => EvaluatorArtifacts> {
  const mod = (await import('../src/evolution/evaluator-identity.ts')) as {
    resolveEvaluatorArtifacts?: (moduleDir?: string) => EvaluatorArtifacts
  }
  expect(mod.resolveEvaluatorArtifacts, 'resolveEvaluatorArtifacts export').toBeTypeOf('function')
  return mod.resolveEvaluatorArtifacts as (moduleDir?: string) => EvaluatorArtifacts
}

beforeAll(() => {
  runBuild()
  publishedRoot = makeTemp('ds-agent-eval-pack-published-')
  assemblePublishedTree(publishedRoot)
}, 180_000)

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('source checkout evaluator identity', () => {
  it('keeps the four-file evaluator digest stable', () => {
    expect(computeEvaluatorDigest()).toBe(SOURCE_EVALUATOR_DIGEST)
  })
})

describe('published package layout', () => {
  it('ships only the files whitelist, with no src/ or package-root scripts/', () => {
    expect(fs.existsSync(path.join(publishedRoot, 'dist'))).toBe(true)
    expect(fs.existsSync(path.join(publishedRoot, 'src'))).toBe(false)
    expect(fs.existsSync(path.join(publishedRoot, 'scripts'))).toBe(false)
    expect(fs.existsSync(path.join(publishedRoot, 'node_modules'))).toBe(false)
  })

  it('computes a digest from dist without any src/evaluator sources', async () => {
    const identity = await importPublished<EvaluatorIdentityModule>('dist/evolution/evaluator-identity.js')
    const digest = identity.computeEvaluatorDigest()
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).not.toBe(SOURCE_EVALUATOR_DIGEST)
  })

  it('resolves the eval child under dist/scripts and runs it without tsx', async () => {
    const iso = await importPublished<IsolateEvalModule>('dist/evolution/isolate-eval.js')
    const argv = iso.evalChildArgs({
      strategyPath: '/tmp/strategy.json',
      splitPath: '/tmp/split.json',
      splitName: 'train',
    })
    const childScript = argv.find(arg => arg.endsWith('evolution-eval-child.mjs'))
    expect(childScript).toBe(path.join(publishedRoot, 'dist/scripts/evolution-eval-child.mjs'))
    expect(childScript && fs.existsSync(childScript)).toBe(true)
    expect(argv).not.toContain('--import')
    expect(argv.some(arg => arg.includes('tsx'))).toBe(false)
  })

  it('scores a tiny fixture through plain node in the published layout', async () => {
    const iso = await importPublished<IsolateEvalModule>('dist/evolution/isolate-eval.js')
    const workDir = makeTemp('ds-agent-eval-pack-work-')
    const strategy: DeliverGateStrategyV1 = {
      schemaVersion: 2,
      domain: 'deliver-gate-v1',
      positiveTokens: ['ship'],
      negativeTokens: ['blocked'],
      clauseLocalPositive: false,
    }
    const cases: EvolutionEvalCase[] = [
      { id: 'deliver-case', speculative: true, report: { kind: 'ready', text: 'ready to ship' }, expected: 'deliver' },
      { id: 'discard-case', speculative: true, report: { kind: 'ready', text: 'blocked by policy' }, expected: 'discard' },
    ]
    const result = await iso.isolatedEvaluateSplit(workDir, strategy, 'train', cases, { evalTimeoutMs: 20_000 })
    expect(result.ok, result.error).toBe(true)
    expect(result.score?.accuracy).toBe(1)
    expect(Number.isFinite(result.score?.accuracy)).toBe(true)
  })
})

describe('evaluator artifact resolver', () => {
  it('prefers source .ts files and the repo scripts child', async () => {
    const resolve = await loadResolver()
    const repo = makeTemp('ds-agent-eval-pack-resolver-src-')
    writeFiles(repo, {
      'src/evolution/score.ts': '// score',
      'src/evolution/strategy-gate.ts': '// gate',
      'src/evolution/safe-pattern.ts': '// safe',
      'scripts/evolution-eval-child.mjs': '// child',
    })
    const resolved = resolve(path.join(repo, 'src/evolution'))
    expect(resolved.repoRoot).toBe(repo)
    expect(resolved.score).toBe(path.join(repo, 'src/evolution/score.ts'))
    expect(resolved.strategyGate).toBe(path.join(repo, 'src/evolution/strategy-gate.ts'))
    expect(resolved.safePattern).toBe(path.join(repo, 'src/evolution/safe-pattern.ts'))
    expect(resolved.childScript).toBe(path.join(repo, 'scripts/evolution-eval-child.mjs'))
  })

  it('falls back to dist .js files and dist/scripts when src is absent', async () => {
    const resolve = await loadResolver()
    const pkg = makeTemp('ds-agent-eval-pack-resolver-dist-')
    writeFiles(pkg, {
      'dist/evolution/score.js': '// score',
      'dist/evolution/strategy-gate.js': '// gate',
      'dist/evolution/safe-pattern.js': '// safe',
      'dist/scripts/evolution-eval-child.mjs': '// child',
    })
    const resolved = resolve(path.join(pkg, 'dist/evolution'))
    expect(resolved.repoRoot).toBe(pkg)
    expect(resolved.score).toBe(path.join(pkg, 'dist/evolution/score.js'))
    expect(resolved.strategyGate).toBe(path.join(pkg, 'dist/evolution/strategy-gate.js'))
    expect(resolved.safePattern).toBe(path.join(pkg, 'dist/evolution/safe-pattern.js'))
    expect(resolved.childScript).toBe(path.join(pkg, 'dist/scripts/evolution-eval-child.mjs'))
  })

  it('throws a clear error when an evaluator source is missing', async () => {
    const resolve = await loadResolver()
    const broken = makeTemp('ds-agent-eval-pack-resolver-missing-')
    writeFiles(broken, {
      'src/evolution/score.ts': '// score',
      'src/evolution/strategy-gate.ts': '// gate',
      'scripts/evolution-eval-child.mjs': '// child',
    })
    expect(() => resolve(path.join(broken, 'src/evolution'))).toThrowError(/evaluator source missing/)
  })

  it('throws a clear error when the child script is missing', async () => {
    const resolve = await loadResolver()
    const broken = makeTemp('ds-agent-eval-pack-resolver-no-child-')
    writeFiles(broken, {
      'src/evolution/score.ts': '// score',
      'src/evolution/strategy-gate.ts': '// gate',
      'src/evolution/safe-pattern.ts': '// safe',
    })
    expect(() => resolve(path.join(broken, 'src/evolution'))).toThrowError(/evaluator source missing/)
  })
})
