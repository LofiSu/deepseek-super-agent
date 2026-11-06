import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_CORPUS,
  FIXTURE_READER,
  OBSERVATION_DATE,
  PROTOCOL_QUERIES,
  runT48MonthScaleProtocol,
  SYNTHETIC_MONTHS,
} from '../scripts/t48-month-scale-protocol.ts'
import type { LongTermMemoryEntry } from '../src/memory/long-term.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

/**
 * The fixture smoke in `scripts/t48-month-scale-protocol.ts` exercises the
 * month-scale measurement hooks offline: synthetic `createdAt` values months
 * apart, an injected clock advanced past the hot retention window, cold digest
 * survival, ACL preservation, the default-offline semantic arm, and
 * determinism. It is not wall-clock evidence and does not unblock T48.
 */
describe('T48 month-scale LTM protocol (offline fixture smoke)', () => {
  it('measures cold recall@3, digest survival, ACL, semantic arm, and determinism', () => {
    const report = runT48MonthScaleProtocol()

    // The report must stay honest about what it is.
    expect(report.kind).toBe('t48-fixture-smoke')
    expect(report.synthetic).toBe(true)
    expect(report.completionEvidence).toBe(false)
    expect(report.syntheticMonths).toEqual(SYNTHETIC_MONTHS)
    expect(report.syntheticMonths.length).toBeGreaterThanOrEqual(2)

    // Hot entries from every synthetic month age out; one fresh entry survives.
    expect(report.metrics.hotEntriesBeforePrune).toBe(FIXTURE_CORPUS.length)
    expect(report.metrics.hotEntriesPruned).toBe(FIXTURE_CORPUS.length)
    expect(report.metrics.hotEntriesAfterPrune).toBe(1)
    expect(report.metrics.coldDigests).toBe(FIXTURE_CORPUS.length)
    expect(report.metrics.digestSurvival).toBe(1)
    expect(report.metrics.coldRecallAt3).toBe(1)
    expect(report.queries.map(query => query.id)).toEqual(PROTOCOL_QUERIES.map(query => query.id))
    expect(report.queries.every(query => query.recallAt3 === 1)).toBe(true)

    // Same store, lexical-only: the semantic query cannot hit. With the port it
    // does, so the arm contributes at least one hit.
    expect(report.metrics.semanticLexicalHits).toBe(0)
    expect(report.metrics.semanticHybridHits).toBeGreaterThan(0)
    expect(report.metrics.semanticArmContribution)
      .toBe(report.metrics.semanticHybridHits - report.metrics.semanticLexicalHits)
    expect(report.metrics.semanticArmContribution).toBeGreaterThan(0)

    // A digest spill is unreadable before recall, readable to the reader after
    // recall, and still unreadable to an unrelated reader.
    expect(report.metrics.aclEnforcedBeforeRecall).toBe(true)
    expect(report.metrics.aclGrantedAfterRecall).toBe(true)
    expect(report.metrics.aclStillEnforcedForOtherReaders).toBe(true)

    expect(report.metrics.deterministicWithinSession).toBe(true)
    expect(report.metrics.deterministicAfterReopen).toBe(true)
  })

  it('persists cold digests with embeddings and recall grants on disk', () => {
    const home = tempHome()
    try {
      runT48MonthScaleProtocol({ home })
      const store = new Store(home)
      try {
        const docs = store.listDocs<LongTermMemoryEntry>('ltm')
        const hot = docs.filter(entry => (entry.tier ?? 'hot') === 'hot')
        const digests = docs.filter(entry => entry.tier === 'cold' && entry.kind === 'digest')

        expect(hot).toHaveLength(1)
        expect(digests).toHaveLength(FIXTURE_CORPUS.length)
        for (const digest of digests) {
          expect(digest.embedding?.length).toBeGreaterThan(0)
          expect(digest.embeddingId).toMatch(/^hashed-v1:/)
          expect(store.getSpill(digest.spillId)).toBeTruthy()
        }

        const billing = digests.find(digest => digest.tags?.includes('billing'))
        expect(billing).toBeDefined()
        // Digests are stamped by the injected observation clock, not wall time.
        expect(billing!.createdAt).toBe(OBSERVATION_DATE)
        // Recall granted only the reader that queried, not every ticket.
        expect(store.spillGrants(billing!.spillId)).toContain(`ticket:${FIXTURE_READER}`)
        expect(store.spillGrants(billing!.spillId)).not.toContain('ticket:ticket_unrelated_reader')
      } finally {
        store.close()
      }
    } finally {
      // The harness intentionally keeps a caller-supplied home; clean it here.
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
