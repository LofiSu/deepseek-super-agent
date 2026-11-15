import fs from 'node:fs'
import path from 'node:path'
import type { Store } from '../store/sqlite.ts'
import type { DispatchOwnerConfig } from './config.ts'
import { trustedFetch } from './trusted-fetch.ts'
import {
  DISPATCH_GAP_KIND,
  DISPATCH_JOB_KIND,
  findGapByDedupe,
  getQueueState,
  putDispatchJob,
  putGap,
  putQueueState,
  type DispatchGapDoc,
  type DispatchJobDoc,
} from './store.ts'

export const RSI_RESEARCH_CACHE_KIND = 'rsi_research_cache'

const HIGH_RISK_PATTERNS = [
  /publish\s+policy/i,
  /branch\s+protection/i,
  /vault|seccomp|bwrap/i,
  /admission|trust\s+policy/i,
  /sandbox|network\s+policy/i,
  /force\s+push|merge\s+to\s+main/i,
  /eval\s+threshold/i,
  /authorizedActors|authorized\s+actors/i,
  /credential|secret/i,
  /webhook\s+signature/i,
  /FeaturePrPublisher|publish\s+intermediary/i,
] as const

const BUSYWORK_TITLE = /^research snapshot:/i

export function classifyGapRisk(title: string, description: string): 'low' | 'high' {
  const blob = `${title}\n${description}`
  return HIGH_RISK_PATTERNS.some(re => re.test(blob)) ? 'high' : 'low'
}

export function isImplementableLowRiskGap(gap: DispatchGapDoc): boolean {
  if (gap.risk !== 'low' || gap.status !== 'open') return false
  if (BUSYWORK_TITLE.test(gap.title)) return false
  if (!gap.acceptance?.trim()) return false
  return true
}

export interface RsiIngestInput {
  title: string
  description: string
  acceptance: string
  sourceUrl: string
  fetchedAt: string
  dedupeKey?: string
}

export function ingestGap(
  store: Store,
  input: RsiIngestInput,
  nextId: (prefix: string) => string,
): DispatchGapDoc | undefined {
  const dedupeKey = input.dedupeKey ?? input.sourceUrl
  const existing = findGapByDedupe(store, dedupeKey)
  if (existing) return existing

  if (!input.acceptance?.trim()) return undefined

  const risk = classifyGapRisk(input.title, input.description)
  const gap: DispatchGapDoc = {
    id: nextId('gap'),
    title: input.title,
    description: input.description,
    acceptance: input.acceptance,
    risk,
    priority: risk === 'high' ? 0 : 10,
    sourceUrl: input.sourceUrl,
    fetchedAt: input.fetchedAt,
    manusCue: 'unknown',
    status: risk === 'high' ? 'proposal' : 'open',
    dedupeKey,
  }
  putGap(store, gap)

  if (risk === 'high') {
    putDispatchJob(store, {
      id: nextId('dispatch'),
      type: 'rsi_proposal',
      status: 'queued',
      createdAt: new Date().toISOString(),
      commentId: `gap-${gap.id}`,
      gapId: gap.id,
    })
  }
  return gap
}

function recordResearchCache(
  store: Store,
  host: string,
  payload: { ok: true; body: string; fetchedAt: string; url: string } | { ok: false; error: string; at: string },
): void {
  const id = `host:${host.toLowerCase()}`
  store.putDoc(RSI_RESEARCH_CACHE_KIND, id, { host, ...payload })
}

/**
 * Parse docs/INSTINCT_CAPABILITIES.md rows with status `missing` and non-empty acceptance.
 */
export function ingestInstinctCapabilitiesFromFile(
  store: Store,
  repoRoot: string,
  nextId: (prefix: string) => string,
): DispatchGapDoc[] {
  const file = path.join(repoRoot, 'docs', 'INSTINCT_CAPABILITIES.md')
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const created: DispatchGapDoc[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || trimmed.startsWith('|---')) continue
    const parts = trimmed.split('|').map(c => c.trim())
    const cells = parts.filter((_, i) => i > 0 && i < parts.length - 1)
    if (cells.length < 6) continue
    const title = cells[1]
    if (!title || /^(#|能力项)$/.test(title)) continue
    const statusRaw = cells[4]?.replace(/`/g, '').trim().toLowerCase()
    if (statusRaw !== 'missing') continue
    const acceptance = `Capability "${title}" marked missing in docs/INSTINCT_CAPABILITIES.md; add regression test or documented stub.`
    const gap = ingestGap(store, {
      title,
      description: cells[2] ?? title,
      acceptance,
      sourceUrl: `file://${file}`,
      fetchedAt: new Date().toISOString(),
      dedupeKey: `instinct-cap:${title.slice(0, 120)}`,
    }, nextId)
    if (gap) created.push(gap)
  }
  return created
}

export interface RsiTickResult {
  idle: boolean
  reason?: string
  gapId?: string
}

/**
 * Bounded scheduler tick: allowlisted fetch updates research cache only;
 * structured gaps from docs/INSTINCT_CAPABILITIES.md; at most one low-risk implement.
 */
export async function runRsiSchedulerTick(
  store: Store,
  config: DispatchOwnerConfig,
  nextId: (prefix: string) => string,
  deps: {
    fetchPage?: (url: string) => Promise<{ body: string; fetchedAt: string }>
    hasOpenPeanutPr?: (branch: string) => Promise<boolean>
    log?: (line: string) => void
    repoRoot?: string
  } = {},
): Promise<RsiTickResult> {
  const log = deps.log ?? (() => undefined)
  if (!config.rsi.enabled) return { idle: true, reason: 'rsi disabled' }

  const queue = getQueueState(store)
  const now = Date.now()
  const last = queue.lastRsiTickAt ? Date.parse(queue.lastRsiTickAt) : 0
  if (last > 0 && now - last < config.rsi.intervalMs) {
    return { idle: true, reason: 'interval not elapsed' }
  }
  putQueueState(store, { ...queue, lastRsiTickAt: new Date().toISOString() })

  const started = Date.now()
  for (const host of config.rsi.fetchAllowlist.slice(0, 3)) {
    const url = `https://${host}/`
    try {
      const fetched = deps.fetchPage
        ? { ...(await deps.fetchPage(url)), url }
        : await trustedFetch(url, { allowHosts: config.rsi.fetchAllowlist })
      recordResearchCache(store, host, {
        ok: true,
        body: fetched.body.slice(0, 32_000),
        fetchedAt: fetched.fetchedAt,
        url,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      recordResearchCache(store, host, { ok: false, error: msg, at: new Date().toISOString() })
      log(`[rsi] fetch ${host} recorded failure: ${msg}`)
    }
  }

  const repoRoot = deps.repoRoot ?? process.cwd()
  ingestInstinctCapabilitiesFromFile(store, repoRoot, nextId)

  const openGaps = store.listDocs<DispatchGapDoc>(DISPATCH_GAP_KIND)
    .filter(isImplementableLowRiskGap)
    .sort((a, b) => b.priority - a.priority)

  if (openGaps.length === 0) {
    log(`[rsi] tick idle ${Date.now() - started}ms no implementable low-risk gap`)
    return { idle: true, reason: 'no gap' }
  }

  const pick = openGaps[0]!
  const branch = `peanut/rsi-${pick.id}`
  if (deps.hasOpenPeanutPr && await deps.hasOpenPeanutPr(branch)) {
    log(`[rsi] idle duplicate open PR for ${branch}`)
    return { idle: true, reason: 'duplicate pr' }
  }

  const pending = store.listDocs<DispatchJobDoc>(DISPATCH_JOB_KIND)
    .some(j => j.type === 'rsi_implement' && (j.status === 'queued' || j.status === 'running'))
  if (pending) return { idle: true, reason: 'implement already queued' }

  putDispatchJob(store, {
    id: nextId('dispatch'),
    type: 'rsi_implement',
    status: 'queued',
    createdAt: new Date().toISOString(),
    commentId: `gap-impl-${pick.id}`,
    gapId: pick.id,
  })
  log(`[rsi] enqueued implement ${pick.id} elapsed=${Date.now() - started}ms`)
  return { idle: false, gapId: pick.id }
}

