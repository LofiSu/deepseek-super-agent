export type TopologyKind = 'dual-layer' | 'router-sharded' | 'worker-mesh' | 'worker-direct'

export interface TopologyEdge {
  from: 'router' | 'worker' | 'shard'
  to: 'router' | 'worker' | 'shard'
  kind: 'assign' | 'report' | 'peer' | 'direct'
}

/** Named wiring. Only `dual-layer` runs. The others are documented shapes. */
export interface TopologyStub {
  kind: TopologyKind
  runnable: boolean
  routerOwnsOutbound: boolean
  summary: string
  edges: TopologyEdge[]
}

export const TOPOLOGIES: readonly TopologyStub[] = [
  {
    kind: 'dual-layer',
    runnable: true,
    routerOwnsOutbound: true,
    summary: 'One router sequence point assigns workers. Workers report back. This is the process default.',
    edges: [
      { from: 'router', to: 'worker', kind: 'assign' },
      { from: 'worker', to: 'router', kind: 'report' },
    ],
  },
  {
    kind: 'router-sharded',
    runnable: false,
    routerOwnsOutbound: true,
    summary: 'Several sequence points, chosen by RouterShard. Selection can run in-process; extra processes are not started.',
    edges: [
      { from: 'shard', to: 'worker', kind: 'assign' },
      { from: 'worker', to: 'shard', kind: 'report' },
    ],
  },
  {
    kind: 'worker-mesh',
    runnable: false,
    routerOwnsOutbound: true,
    summary: 'Workers could share peer links. Those links are not started. User-facing replies stay on the router.',
    edges: [
      { from: 'router', to: 'worker', kind: 'assign' },
      { from: 'worker', to: 'router', kind: 'report' },
      { from: 'worker', to: 'worker', kind: 'peer' },
    ],
  },
  {
    kind: 'worker-direct',
    runnable: false,
    routerOwnsOutbound: true,
    summary: 'Workers would hand work across without a router hop. That path is not started.',
    edges: [
      { from: 'worker', to: 'worker', kind: 'direct' },
    ],
  },
]

export function activeTopology(): TopologyStub {
  const current = TOPOLOGIES.find(item => item.kind === 'dual-layer')
  if (!current) throw new Error('dual-layer topology is missing')
  return current
}

export function topologyByKind(kind: TopologyKind): TopologyStub {
  const found = TOPOLOGIES.find(item => item.kind === kind)
  if (!found) throw new Error(`unknown topology ${kind}`)
  return found
}
