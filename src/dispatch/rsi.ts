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
  /environment-blocked/i,
  /WhatsApp|SMS\b|email\s+inbound|PSTN|\bphone\b|SIP\b/i,
  /credential|vault|payment|merchant/i,
  /publish\s+policy|branch\s+protection/i,
  /admission|trust\s+policy|authorizedActors|authorized\s+actors|mentionHandles/i,
  /sandbox|network\s+policy|seccomp|bwrap/i,
  /force\s+push|merge\s+to\s+main/i,
  /eval\s+threshold|memory-recall-eval/i,
  /webhook\s+signature/i,
  /FeaturePrPublisher|publish\s+intermediary|GithubOutbox/i,
  /Google\s+Workspace|\bOAuth\b|Gmail\s+connector/i,
  /cloud\s+browser|\bE2B\b/i,
  /unverified\s+third[- ]party\s+identity/i,
  /public\s+mesh|A2A\s+listener|mesh\s+peer/i,
] as const

const BUSYWORK_TITLE = /^research snapshot:/i
const AUTO_STUB_ACCEPTANCE = /add\s+(a\s+)?stub\s+test|auto-generated/i

export function classifyGapRisk(title: string, description: string, notes = ''): 'low' | 'high' {
  const blob = `${title}\n${description}\n${notes}`
  return HIGH_RISK_PATTERNS.some(re => re.test(blob)) ? 'high' : 'low'
}

export function isImplementableLowRiskGap(gap: DispatchGapDoc): boolean {
  if (gap.risk !== 'low' || gap.status !== 'open') return false
  if (BUSYWORK_TITLE.test(gap.title)) return false
  if (!gap.acceptance?.trim()) return false
  if (AUTO_STUB_ACCEPTANCE.test(gap.acceptance)) return false
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

  const risk = classifyGapRisk(input.title, input.description, input.acceptance)
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

function upsertStructuredGap(
  store: Store,
  draft: Omit<DispatchGapDoc, 'id'> & { dedupeKey: string },
  nextId: (prefix: string) => string,
): DispatchGapDoc | undefined {
  const existing = findGapByDedupe(store, draft.dedupeKey)
  if (existing) {
    if (existing.status === 'implemented' || existing.status === 'dismissed') return existing
    const merged: DispatchGapDoc = {
      ...existing,
      title: draft.title,
      description: draft.description,
      acceptance: draft.acceptance,
      risk: draft.risk,
      priority: draft.priority,
      sourceUrl: draft.sourceUrl,
      fetchedAt: draft.fetchedAt,
      status: draft.status,
    }
    putGap(store, merged)
    return merged
  }

  const gap: DispatchGapDoc = { ...draft, id: nextId('gap') }
  putGap(store, gap)
  if (gap.risk === 'high' && gap.status === 'proposal') {
    const hasProposalJob = store.listDocs<DispatchJobDoc>(DISPATCH_JOB_KIND)
      .some(j => j.type === 'rsi_proposal' && j.gapId === gap.id)
    if (!hasProposalJob) {
      putDispatchJob(store, {
        id: nextId('dispatch'),
        type: 'rsi_proposal',
        status: 'queued',
        createdAt: new Date().toISOString(),
        commentId: `gap-${gap.id}`,
        gapId: gap.id,
      })
    }
  }
  return gap
}

function stripMd(cell: string): string {
  return cell.replace(/`/g, '').trim()
}

function isMissingStatusCell(cell: string | undefined): boolean {
  const v = stripMd(cell ?? '').toLowerCase()
  return v === 'missing' || v.startsWith('missing')
}

function isEnvironmentBlockedCell(cell: string | undefined): boolean {
  const v = stripMd(cell ?? '').toLowerCase()
  return v.includes('environment-blocked') || v === 'environment-blocked'
}

const INSTINCT_ACCEPTANCE_DISCLAIMER =
  /不是验收标准|不要用|不把[^。；\n]{0,40}当|不当[^。；\n]{0,24}能力|无实现|没有实现|不列入验收|environment-blocked|不等于|不是本仓库当前能力/i

/** Extract testable acceptance from 验收/依据 column — fail-closed; no length heuristics. */
export function acceptanceFromInstinctEvidenceColumn(evidenceCell: string): string {
  const raw = stripMd(evidenceCell)
  if (!raw) return ''
  if (/^无|^n\/a$/i.test(raw)) return ''
  if (INSTINCT_ACCEPTANCE_DISCLAIMER.test(raw)) return ''
  const testFile = raw.match(/`([^`]+\.test\.ts)`/)?.[1]
  if (testFile) return `Offline test file ${testFile} passes in CI holdout.`
  const bareTest = raw.match(/(test\/[\w./-]+\.test\.ts)/)
  if (bareTest) return `Offline test ${bareTest[1]} passes.`
  return ''
}

function recordResearchCache(
  store: Store,
  host: string,
  payload: { ok: true; body: string; fetchedAt: string; url: string } | { ok: false; error: string; at: string },
): void {
  const id = `host:${host.toLowerCase()}`
  store.putDoc(RSI_RESEARCH_CACHE_KIND, id, { host, ...payload })
}

function normalizeUrlForResearchCache(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.toString()
  } catch {
    return url.trim()
  }
}

function recordSourceUrlResearchCache(
  store: Store,
  url: string,
  payload: { ok: true; body: string; fetchedAt: string; url: string } | { ok: false; error: string; at: string; url: string },
): void {
  const normalized = normalizeUrlForResearchCache(url)
  const id = `url:${normalized}`
  store.putDoc(RSI_RESEARCH_CACHE_KIND, id, { ...payload, url: normalized })
}

/**
 * Parse docs/INSTINCT_CAPABILITIES.md rows with status `missing`.
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
  const fetchedAt = new Date().toISOString()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || trimmed.startsWith('|---')) continue
    const parts = trimmed.split('|').map(c => c.trim())
    const cells = parts.filter((_, i) => i > 0 && i < parts.length - 1)
    if (cells.length < 6) continue
    const title = cells[1]
    if (!title || /^(#|能力项)$/.test(title)) continue
    const statusCell = cells[4] ?? ''
    if (!isMissingStatusCell(statusCell) && !isEnvironmentBlockedCell(statusCell)) continue

    const evidence = cells[5] ?? ''
    const description = `${cells[2] ?? title}\nStatus: ${stripMd(statusCell)}`
    const notes = `${description}\n${evidence}`
    const risk = classifyGapRisk(title, description, notes)
    const acceptance = risk === 'high' ? '' : acceptanceFromInstinctEvidenceColumn(evidence)
    const dedupeKey = `instinct-cap:${title.slice(0, 120)}`

    let status: DispatchGapDoc['status'] = 'proposal'
    if (risk === 'low' && acceptance.trim()) status = 'open'

    const draft = {
      title,
      description,
      acceptance,
      risk,
      priority: risk === 'high' ? 0 : 10,
      sourceUrl: `file://${file}`,
      fetchedAt,
      manusCue: 'unknown' as const,
      status,
      dedupeKey,
    }
    const gap = upsertStructuredGap(store, draft, nextId)
    if (gap) created.push(gap)
  }
  return created
}

function competitiveGapVerdictIsActionable(verdict: string): boolean {
  return /\*\*Behind\*\*|\bBehind\b|\*\*Missing\*\*|\bMissing\b|\*\*Partial\*\*|\bPartial\b/i.test(verdict)
    || /\bbehind\b/i.test(verdict)
}

/**
 * Ingest docs/COMPETITIVE_GAP.md scorecard rows with Verdict Behind, Missing, or Partial.
 */
export function ingestCompetitiveGapFromFile(
  store: Store,
  repoRoot: string,
  nextId: (prefix: string) => string,
): DispatchGapDoc[] {
  const file = path.join(repoRoot, 'docs', 'COMPETITIVE_GAP.md')
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const created: DispatchGapDoc[] = []
  const fetchedAt = new Date().toISOString()

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || trimmed.startsWith('|---')) continue
    const parts = trimmed.split('|').map(c => c.trim())
    const cells = parts.filter((_, i) => i > 0 && i < parts.length - 1)
    if (cells.length < 6) continue
    const dimension = cells[0]?.replace(/\*\*/g, '').trim() ?? ''
    if (!dimension || /^dimension$/i.test(dimension)) continue
    const dsAgent = cells[4] ?? ''
    const verdict = cells[5] ?? ''
    if (!competitiveGapVerdictIsActionable(verdict)) continue

    const title = `Competitive gap: ${dimension}`
    const description = `Verdict: ${stripMd(verdict)}. ds-agent: ${dsAgent.slice(0, 400)}`
    const risk = classifyGapRisk(title, description, dsAgent)
    const acceptance = ''
    const dedupeKey = `competitive-gap:${dimension.slice(0, 80)}`

    const gap = upsertStructuredGap(store, {
      title,
      description,
      acceptance,
      risk,
      priority: 0,
      sourceUrl: `file://${file}`,
      fetchedAt,
      manusCue: 'unknown',
      status: 'proposal',
      dedupeKey,
    }, nextId)
    if (gap) created.push(gap)
  }
  return created
}

function gapHasActiveImplement(store: Store, gapId: string): boolean {
  return store.listDocs<DispatchJobDoc>(DISPATCH_JOB_KIND).some(j =>
    j.type === 'rsi_implement'
    && j.gapId === gapId
    && (j.status === 'queued' || j.status === 'running' || j.status === 'completed'),
  )
}

export interface RsiTickResult {
  idle: boolean
  reason?: string
  gapId?: string
}

/**
 * Bounded scheduler tick: allowlisted fetch updates research cache only;
 * structured gaps from local docs; at most one low-risk implement.
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

  for (const src of config.rsi.sourceUrls) {
    if (src.startsWith('file://')) continue
    try {
      const fetched = deps.fetchPage
        ? { ...(await deps.fetchPage(src)), url: src }
        : await trustedFetch(src, { allowHosts: config.rsi.fetchAllowlist })
      recordSourceUrlResearchCache(store, src, {
        ok: true,
        body: fetched.body.slice(0, 32_000),
        fetchedAt: fetched.fetchedAt,
        url: fetched.url,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      recordSourceUrlResearchCache(store, src, {
        ok: false,
        error: msg,
        at: new Date().toISOString(),
        url: normalizeUrlForResearchCache(src),
      })
      log(`[rsi] sourceUrl fetch recorded failure ${src}: ${msg}`)
    }
  }

  const repoRoot = deps.repoRoot ?? process.cwd()
  ingestInstinctCapabilitiesFromFile(store, repoRoot, nextId)
  ingestCompetitiveGapFromFile(store, repoRoot, nextId)

  const openGaps = store.listDocs<DispatchGapDoc>(DISPATCH_GAP_KIND)
    .filter(isImplementableLowRiskGap)
    .filter(g => !gapHasActiveImplement(store, g.id))
    .sort((a, b) => b.priority - a.priority)

  if (openGaps.length === 0) {
    log(`[rsi] tick idle ${Date.now() - started}ms no implementable low-risk gap`)
    return { idle: true, reason: 'no gap' }
  }

  const pick = openGaps[0]!
  const branch = `peanut/rsi-${pick.id}`
  if (deps.hasOpenPeanutPr) {
    try {
      if (await deps.hasOpenPeanutPr(branch)) {
        log(`[rsi] idle duplicate open PR for ${branch}`)
        return { idle: true, reason: 'duplicate pr' }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log(`[rsi] idle: open PR check failed (${msg}); refusing enqueue`)
      return { idle: true, reason: 'pr check failed' }
    }
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
