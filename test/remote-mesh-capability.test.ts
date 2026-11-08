import { describe, expect, it } from 'vitest'
import { WorkerMeshRegistry } from '../src/harness/mesh.ts'
import { WorkerPlacement, requiredMeshCapabilities } from '../src/harness/mesh-runtime.ts'
import { RemoteMeshRegistry } from '../src/harness/remote-node.ts'

const SECRET = 'a'.repeat(32)

interface RemoteSpec {
  id: string
  capabilities?: readonly string[]
}

function placementWith(
  remotes: readonly RemoteSpec[],
  localCapacity = 4,
): { placement: WorkerPlacement; local: WorkerMeshRegistry } {
  const local = new WorkerMeshRegistry([{ id: 'local', capacity: localCapacity }])
  const remote = new RemoteMeshRegistry({ localPeerId: 'local' })
  for (const node of remotes) {
    remote.register({
      id: node.id,
      url: `http://127.0.0.1:9/${node.id}`,
      peerId: `worker-${node.id}`,
      secret: SECRET,
      capacity: 2,
      capabilities: node.capabilities,
    })
  }
  return { placement: new WorkerPlacement('local', local, remote), local }
}

describe('remote mesh capability matching', () => {
  it('skips remote nodes missing required capabilities', () => {
    const local = new WorkerMeshRegistry([{ id: 'local', capacity: 1 }])
    const remote = new RemoteMeshRegistry({ localPeerId: 'host' })
    remote.register({
      id: 'generic',
      url: 'http://127.0.0.1:9/a2a',
      peerId: 'worker-g',
      secret: SECRET,
      capacity: 2,
    })
    remote.register({
      id: 'linux',
      url: 'http://127.0.0.1:8/a2a',
      peerId: 'worker-l',
      secret: SECRET,
      capacity: 2,
      capabilities: ['linux', 'bwrap'],
    })
    const placement = new WorkerPlacement('local', local, remote)
    expect(placement.pickNode('block_local')).toBe('local')
    expect(placement.pickNode('t1', ['linux'])).toBe('linux')
    expect(placement.pickNode('t2', ['darwin'])).toBeUndefined()
    expect(placement.pickNode('t3', [])).toBe('generic')
    placement.release('t1')
    placement.release('t3')
  })

  it('skips a free local node when capabilities are required', () => {
    const { placement, local } = placementWith([
      { id: 'generic' },
      { id: 'linux', capabilities: ['linux'] },
    ])

    // Local has free capacity, but it advertises no capabilities, so the
    // ticket must go to the matching remote instead of the local node.
    expect(placement.pickNode('caps-free-local', ['linux'])).toBe('linux')
    expect(local.inFlight('local')).toBe(0)
  })

  it('returns undefined instead of local when no remote matches capabilities', () => {
    const { placement, local } = placementWith([{ id: 'generic' }])

    expect(placement.pickNode('caps-no-match', ['darwin'])).toBeUndefined()
    expect(local.inFlight('local')).toBe(0)
  })

  it('keeps local-first placement when capabilities are empty', () => {
    const { placement, local } = placementWith([{ id: 'linux', capabilities: ['linux'] }])

    expect(placement.pickNode('caps-empty', [])).toBe('local')
    expect(local.inFlight('local')).toBe(1)
  })

  it('releases a sticky local assignment when capabilities become required', () => {
    const { placement, local } = placementWith([{ id: 'linux', capabilities: ['linux'] }])

    expect(placement.pickNode('caps-sticky', [])).toBe('local')
    expect(local.inFlight('local')).toBe(1)

    // A later pick with requirements must not keep the ticket on local.
    expect(placement.pickNode('caps-sticky', ['linux'])).toBe('linux')
    expect(local.inFlight('local')).toBe(0)
  })

  it('parses DS_AGENT_MESH_REQUIRED_CAPABILITIES', () => {
    expect(requiredMeshCapabilities({ DS_AGENT_MESH_REQUIRED_CAPABILITIES: ' linux , bwrap ' })).toEqual([
      'linux', 'bwrap',
    ])
    expect(requiredMeshCapabilities({})).toEqual([])
  })
})
