import { describe, it, expect } from 'vitest'
import { createPuzzleState } from './puzzle'
import { createClusterIndex } from './unionFind'
import { serializePuzzleState, restorePuzzleState } from './save'
import { makeTestBuild } from './testFixtures'

describe('serializePuzzleState and restorePuzzleState', () => {
  it('round trips positions and cluster membership exactly', () => {
    const build = makeTestBuild(3, 3, 100)
    const state = createPuzzleState(build)
    const clusters = createClusterIndex(state.parent)

    state.x[4] = 137.5
    state.y[4] = -12
    clusters.union(0, 1)
    clusters.union(1, 2)

    const saved = serializePuzzleState(state)
    const restored = restorePuzzleState(build, saved)
    const restoredClusters = createClusterIndex(restored.parent)

    expect(Array.from(restored.x)).toEqual(Array.from(state.x))
    expect(Array.from(restored.y)).toEqual(Array.from(state.y))
    expect(restoredClusters.membersOf(0)).toEqual(new Set([0, 1, 2]))
    expect(restoredClusters.find(4)).toBe(4)
  })

  it('never restores heldBy, a resumed piece is never mid-drag', () => {
    const build = makeTestBuild(2, 2, 100)
    const state = createPuzzleState(build)
    state.heldBy[0] = 7

    const saved = serializePuzzleState(state)
    const restored = restorePuzzleState(build, saved)

    expect(Array.from(restored.heldBy)).toEqual([-1, -1, -1, -1])
  })

  it('throws rather than truncating when the save does not match this build', () => {
    const build = makeTestBuild(3, 3, 100)
    const wrongBuild = makeTestBuild(4, 4, 100)
    const state = createPuzzleState(build)
    const saved = serializePuzzleState(state)

    expect(() => restorePuzzleState(wrongBuild, saved)).toThrow()
  })
})
