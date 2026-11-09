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

  it('does not dual-assign after a sticky local node goes offline', () => {
    const local = new WorkerMeshRegistry([{ id: 'local', capacity: 1 }])
    const remote = new RemoteMeshRegistry({ localPeerId: 'host' })
    remote.register({
      id: 'remote-a',
      url: 'http://127.0.0.1:9/a2a',
      peerId: 'worker-a',
      secret: 'a'.repeat(32),
      capacity: 1,
    })
    const placement = new WorkerPlacement('local', local, remote)
    expect(placement.pickNode('t1')).toBe('local')
    placement.local.markOnline(placement.localNodeId, false)
    // Local releases its stale sticky assignment inside pickNode, so the same
    // call can fall through to the remote instead of assigning both.
    expect(placement.pickNode('t1')).toBe('remote-a')
    expect(placement.local.inFlight(placement.localNodeId)).toBe(0)
    expect(remote.inFlight('remote-a')).toBe(1)
  })

  it('keeps a remote sticky placement when local capacity frees', () => {
    const local = new WorkerMeshRegistry([{ id: 'local', capacity: 1 }])
    const remote = new RemoteMeshRegistry({ localPeerId: 'host' })
    remote.register({
      id: 'remote-a',
      url: 'http://127.0.0.1:9/a2a',
      peerId: 'worker-a',
      secret: 'a'.repeat(32),
      capacity: 1,
    })
    const placement = new WorkerPlacement('local', local, remote)
    // Local is full, so the ticket is placed on the remote peer.
    expect(placement.pickNode('filler')).toBe('local')
    expect(placement.pickNode('t-remote')).toBe('remote-a')
    // Local capacity frees, but the remote sticky assignment must hold.
    placement.release('filler')
    expect(placement.pickNode('t-remote')).toBe('remote-a')
    // The ticket occupies only the remote registry, never both.
    expect(local.inFlight(placement.localNodeId)).toBe(0)
    expect(remote.inFlight('remote-a')).toBe(1)
  })

  it('falls back to local when the sticky remote node goes offline', () => {
    const local = new WorkerMeshRegistry([{ id: 'local', capacity: 1 }])
    const remote = new RemoteMeshRegistry({ localPeerId: 'host' })
    remote.register({
      id: 'remote-a',
      url: 'http://127.0.0.1:9/a2a',
      peerId: 'worker-a',
      secret: 'a'.repeat(32),
      capacity: 1,
    })
    const placement = new WorkerPlacement('local', local, remote)
    expect(placement.pickNode('filler')).toBe('local')
    expect(placement.pickNode('t-remote')).toBe('remote-a')
    placement.release('filler')
    remote.markOffline('remote-a')
    // The ineligible remote sticky is released inside pickNode, so the same
    // call falls through to local instead of over-sticking to a dead peer.
    expect(placement.pickNode('t-remote')).toBe('local')
    expect(remote.inFlight('remote-a')).toBe(0)
    expect(local.inFlight(placement.localNodeId)).toBe(1)
  })
})
