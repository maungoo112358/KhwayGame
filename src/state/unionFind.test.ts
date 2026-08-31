import { describe, it, expect } from 'vitest'
import { createClusterIndex } from './unionFind'

describe('createClusterIndex', () => {
  it('starts every piece as its own singleton cluster', () => {
    const parent = Int32Array.from([0, 1, 2, 3, 4])
    const clusters = createClusterIndex(parent)

    for (let id = 0; id < 5; id++) {
      expect(clusters.membersOf(id)).toEqual(new Set([id]))
    }
  })

  it('unions two clusters into one, both directions of find agreeing', () => {
    const parent = Int32Array.from([0, 1, 2, 3])
    const clusters = createClusterIndex(parent)

    clusters.union(0, 1)

    expect(clusters.find(0)).toBe(clusters.find(1))
    expect(clusters.membersOf(0)).toEqual(new Set([0, 1]))
    expect(clusters.membersOf(1)).toEqual(new Set([0, 1]))
  })

  it('chains unions into one growing cluster', () => {
    const parent = Int32Array.from([0, 1, 2, 3, 4])
    const clusters = createClusterIndex(parent)

    clusters.union(0, 1)
    clusters.union(1, 2)
    clusters.union(3, 4)
    clusters.union(2, 3)

    expect(clusters.membersOf(0)).toEqual(new Set([0, 1, 2, 3, 4]))
    expect(clusters.membersOf(4)).toEqual(new Set([0, 1, 2, 3, 4]))
  })

  it('is idempotent, re-unioning two already merged pieces changes nothing', () => {
    const parent = Int32Array.from([0, 1, 2])
    const clusters = createClusterIndex(parent)

    clusters.union(0, 1)
    const before = clusters.membersOf(0)
    clusters.union(0, 1)
    clusters.union(1, 0)

    expect(clusters.membersOf(0)).toEqual(before)
  })

  it('is commutative, union(a, b) and union(b, a) reach the same grouping', () => {
    const parentAB = Int32Array.from([0, 1, 2, 3])
    const clustersAB = createClusterIndex(parentAB)
    clustersAB.union(0, 1)
    clustersAB.union(2, 3)
    clustersAB.union(1, 2)

    const parentBA = Int32Array.from([0, 1, 2, 3])
    const clustersBA = createClusterIndex(parentBA)
    clustersBA.union(1, 0)
    clustersBA.union(3, 2)
    clustersBA.union(2, 1)

    expect(clustersAB.membersOf(0)).toEqual(clustersBA.membersOf(0))
  })

  it('rebuilds an existing grouping from a parent array that already encodes merges', () => {
    // 0 and 1 already merged (1 points at 0), 2 and 3 already merged (3 points at 2), before the
    // index is ever created. This is the resumed-save case: state/commands.ts never gets to build the
    // groups incrementally, createClusterIndex has to recover them from parent alone.
    const parent = Int32Array.from([0, 0, 2, 2])
    const clusters = createClusterIndex(parent)

    expect(clusters.membersOf(1)).toEqual(new Set([0, 1]))
    expect(clusters.membersOf(3)).toEqual(new Set([2, 3]))

    clusters.union(1, 3)
    expect(clusters.membersOf(0)).toEqual(new Set([0, 1, 2, 3]))
  })

  it('path compresses on find, parent starts pointing at the real root afterward', () => {
    // A deliberately long chain, 0 -> 1 -> 2 -> 3, not the flat shape union() itself would produce, to
    // prove find() compresses rather than relying on union() never leaving a chain behind.
    const parent = Int32Array.from([1, 2, 3, 3])
    const clusters = createClusterIndex(parent)

    expect(clusters.find(0)).toBe(3)
    expect(parent[0]).toBe(3)
    expect(parent[1]).toBe(3)
  })
})
