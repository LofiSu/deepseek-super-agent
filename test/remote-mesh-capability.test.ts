import { describe, expect, it } from 'vitest'
import { WorkerMeshRegistry } from '../src/harness/mesh.ts'
import { WorkerPlacement, requiredMeshCapabilities } from '../src/harness/mesh-runtime.ts'
import { RemoteMeshRegistry } from '../src/harness/remote-node.ts'

const SECRET = 'a'.repeat(32)

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

  it('parses DS_AGENT_MESH_REQUIRED_CAPABILITIES', () => {
    expect(requiredMeshCapabilities({ DS_AGENT_MESH_REQUIRED_CAPABILITIES: ' linux , bwrap ' })).toEqual([
      'linux', 'bwrap',
    ])
    expect(requiredMeshCapabilities({})).toEqual([])
  })
})
