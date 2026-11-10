import { describe, expect, it } from 'vitest'
import type { A2AEnvelope } from '../src/channels/a2a.ts'
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

  it('releases a leftover local slot when the remote assignment is cancelled', async () => {
    const local = new WorkerMeshRegistry([{ id: 'local', capacity: 1 }])
    const remote = new RemoteMeshRegistry({
      localPeerId: 'host',
      transportFactory: () => ({
        send: envelope => ({ envelope, status: 'delivered', delivered: 1, persisted: false }),
      }),
    })
    remote.register({
      id: 'remote-a',
      url: 'http://127.0.0.1:9/a2a',
      peerId: 'worker-a',
      secret: 'a'.repeat(32),
      capacity: 1,
    })
    const placement = new WorkerPlacement('local', local, remote)
    expect(placement.pickNode('filler')).toBe('local')
    expect(placement.pickNode('t-dual')).toBe('remote-a')
    placement.release('filler')

    // Simulate residue from a prior race: the ticket is assigned both locally
    // and remotely. pickNode exclusivity prevents this going forward, but a
    // cancel must still heal leftovers. Reach the private map directly rather
    // than adding a production seam only tests would use.
    const residue = local as unknown as { assignments: Map<string, string> }
    residue.assignments.set('t-dual', 'local')
    expect(local.inFlight(placement.localNodeId)).toBe(1)
    expect(remote.inFlight('remote-a')).toBe(1)

    await placement.cancelRemote('t-dual', 'asg_x')

    expect(local.inFlight(placement.localNodeId)).toBe(0)
    expect(remote.inFlight('remote-a')).toBe(0)
    expect(remote.hasTicketAssignment('t-dual')).toBe(false)
    // The healed local capacity is usable again.
    expect(placement.pickNode('t-next')).toBe('local')
  })

  it('cancels a clean remote-only assignment without touching local capacity', async () => {
    const local = new WorkerMeshRegistry([{ id: 'local', capacity: 1 }])
    const remote = new RemoteMeshRegistry({
      localPeerId: 'host',
      transportFactory: () => ({
        send: envelope => ({ envelope, status: 'delivered', delivered: 1, persisted: false }),
      }),
    })
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
    expect(local.inFlight(placement.localNodeId)).toBe(0)

    await placement.cancelRemote('t-remote', 'asg_y')

    expect(remote.inFlight('remote-a')).toBe(0)
    expect(remote.hasTicketAssignment('t-remote')).toBe(false)
    expect(local.inFlight(placement.localNodeId)).toBe(0)
  })

  it('keeps the remote sticky slot when cancelRemote opts out of release', async () => {
    const local = new WorkerMeshRegistry([{ id: 'local', capacity: 1 }])
    const sent: A2AEnvelope[] = []
    const remote = new RemoteMeshRegistry({
      localPeerId: 'host',
      transportFactory: () => ({
        send: envelope => {
          sent.push(envelope)
          return { envelope, status: 'delivered', delivered: 1, persisted: false }
        },
      }),
    })
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

    await placement.cancelRemote('t-remote', 'asg_keep', { release: false })

    // The ended remote worker is told to stop, but the sticky reservation that
    // a live replacement may already own is not stolen.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toMatchObject({
      kind: 'assignment_cancel',
      ticketId: 't-remote',
      assignmentId: 'asg_keep',
    })
    expect(remote.hasTicketAssignment('t-remote')).toBe(true)
    expect(remote.inFlight('remote-a')).toBe(1)

    // The default cancel contract still releases.
    await placement.cancelRemote('t-remote', 'asg_keep')
    expect(remote.hasTicketAssignment('t-remote')).toBe(false)
    expect(remote.inFlight('remote-a')).toBe(0)
  })

  it('keeps the remote sticky slot when a keep-slot cancel targets an offline node', async () => {
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
    await placement.cancelRemote('t-remote', 'asg_offline', { release: false })

    // The offline target cannot receive the cancel, but the live replacement
    // still owns the sticky slot: cancel must not free it behind our back.
    expect(remote.hasTicketAssignment('t-remote')).toBe(true)
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

  it('restores a persisted remote reservation without picking', () => {
    const local = new WorkerMeshRegistry([{ id: 'local', capacity: 1 }])
    const remote = new RemoteMeshRegistry({ localPeerId: 'host' })
    for (const [id, peerId, secret] of [
      ['remote-a', 'worker-a', 'a'.repeat(32)],
      ['remote-b', 'worker-b', 'b'.repeat(32)],
    ] as const) {
      remote.register({ id, url: 'http://127.0.0.1:9/a2a', peerId, secret, capacity: 1 })
    }
    const placement = new WorkerPlacement('local', local, remote)

    // Recovery reconstructs pre-crash truth even when the peer is offline; the
    // cancel itself stays fail-soft, but the reservation must exist first.
    remote.markOffline('remote-a')
    expect(placement.restoreRemoteTicket('t1', 'remote-a')).toBe(true)
    expect(placement.remoteHasTicket('t1')).toBe(true)
    expect(remote.inFlight('remote-a')).toBe(1)
    // No placement search ran, so the local registry was not touched.
    expect(local.inFlight(placement.localNodeId)).toBe(0)

    // Idempotent for the same node; a different or unknown node is a no-op.
    expect(placement.restoreRemoteTicket('t1', 'remote-a')).toBe(true)
    expect(placement.restoreRemoteTicket('t1', 'remote-b')).toBe(false)
    expect(placement.restoreRemoteTicket('t2', 'unknown-node')).toBe(false)
    expect(placement.restoreRemoteTicket('', 'remote-a')).toBe(false)
    expect(remote.inFlight('remote-a')).toBe(1)
    expect(remote.inFlight('remote-b')).toBe(0)
    expect(remote.get('remote-a')?.online).toBe(false)
  })
})
