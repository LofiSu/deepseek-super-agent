import { describe, expect, it } from 'vitest'
import { phase2, WorkerMeshRegistry } from '../src/phase2/index.ts'

describe('T47 WorkerMeshRegistry', () => {
  it('registers nodes and picks one with free capacity', () => {
    const mesh = new WorkerMeshRegistry()
    mesh.register({ id: 'a', capacity: 1 })
    mesh.register({ id: 'b', capacity: 2 })
    expect(mesh.pickNode('t1')?.id).toBe('a')
    expect(mesh.pickNode('t2')?.id).toBe('b')
    expect(mesh.inFlight('a')).toBe(1)
    expect(mesh.inFlight('b')).toBe(1)
  })

  it('returns no node when full and frees capacity on release', () => {
    const mesh = phase2.workerMesh({ id: 'a', capacity: 1 })
    expect(mesh.pickNode('t1')?.id).toBe('a')
    expect(mesh.pickNode('t2')).toBeUndefined()
    mesh.release('t1')
    expect(mesh.pickNode('t2')?.id).toBe('a')
    expect(mesh.inFlight('a')).toBe(1)
  })

  it('does not double count a ticket and rejects invalid nodes', () => {
    const mesh = new WorkerMeshRegistry()
    expect(() => mesh.register({ id: 'a', capacity: 0 })).toThrow()
    mesh.register({ id: 'a', capacity: 1 })
    expect(() => mesh.register({ id: 'a', capacity: 1 })).toThrow()
    expect(mesh.pickNode('t1')?.id).toBe('a')
    expect(mesh.pickNode('t1')?.id).toBe('a')
    expect(mesh.inFlight('a')).toBe(1)
  })
})
