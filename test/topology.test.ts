import { describe, expect, it } from 'vitest'
import { activeTopology, topologyByKind, TOPOLOGIES, type TopologyKind } from '../src/topology/index.ts'

const EXTENDED: TopologyKind[] = ['router-sharded', 'worker-mesh', 'worker-direct']

describe('topologies', () => {
  it('runs dual-layer and only describes the other shapes', () => {
    expect(TOPOLOGIES.map(item => item.kind)).toEqual([
      'dual-layer',
      'router-sharded',
      'worker-mesh',
      'worker-direct',
    ])
    expect(activeTopology()).toMatchObject({ kind: 'dual-layer', runnable: true, routerOwnsOutbound: true })
    for (const kind of EXTENDED) {
      const item = topologyByKind(kind)
      expect(item.runnable).toBe(false)
      expect(item.routerOwnsOutbound).toBe(true)
      expect(item.edges.length).toBeGreaterThan(0)
    }
  })
})
