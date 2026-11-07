import { describe, expect, it } from 'vitest'
import { WorkerMeshRegistry } from '../src/harness/mesh.ts'
import { WorkerPlacement } from '../src/harness/mesh-runtime.ts'
import { RemoteMeshRegistry } from '../src/harness/remote-node.ts'

describe('WorkerPlacement', () => {
  it('prefers local then remote when local is full', () => {
    const local = new WorkerMeshRegistry([{ id: 'local', capacity: 1 }])
    const remote = new RemoteMeshRegistry({ localPeerId: 'host' })
    remote.register({
      id: 'remote-a',
      url: 'http://127.0.0.1:9/a2a',
      peerId: 'worker-a',
      secret: 'a'.repeat(32),
      capacity: 2,
    })
    const placement = new WorkerPlacement('local', local, remote)
    expect(placement.pickNode('t1')).toBe('local')
    expect(placement.pickNode('t2')).toBe('remote-a')
    expect(placement.isRemote('remote-a')).toBe(true)
    expect(placement.isRemote('local')).toBe(false)
    placement.release('t1')
    placement.release('t2')
    expect(remote.inFlight('remote-a')).toBe(0)
  })
})
