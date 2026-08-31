import { describe, it, expect } from 'vitest'
import { createPuzzleState, scatterPieces, isSolved } from './puzzle'
import { createClusterIndex } from './unionFind'
import { makeRng } from '../core'
import { makeTestBuild } from './testFixtures'

describe('createPuzzleState', () => {
  it('starts every piece at its solved position', () => {
    const build = makeTestBuild(3, 3, 100)
    const state = createPuzzleState(build)

    for (const piece of build.pieces) {
      expect(state.x[piece.id]).toBe(piece.solved.x)
      expect(state.y[piece.id]).toBe(piece.solved.y)
    }
  })

  it('starts every piece as its own union find root', () => {
    const build = makeTestBuild(3, 3, 100)
    const state = createPuzzleState(build)

    for (let id = 0; id < state.pieceCount; id++) {
      expect(state.parent[id]).toBe(id)
    }
  })

  it('starts every piece unheld', () => {
    const build = makeTestBuild(2, 2, 100)
    const state = createPuzzleState(build)

    expect(Array.from(state.heldBy)).toEqual([-1, -1, -1, -1])
  })
})

describe('scatterPieces', () => {
  it('keeps every piece within bounds', () => {
    const build = makeTestBuild(4, 4, 50)
    const state = createPuzzleState(build)
    const bounds = { w: 800, h: 600 }
    const rng = makeRng(1, 'scatter-test')

    scatterPieces(state, bounds, rng)

    for (let id = 0; id < state.pieceCount; id++) {
      const piece = state.pieces[id]!
      expect(state.x[id]).toBeGreaterThanOrEqual(0)
      expect(state.y[id]).toBeGreaterThanOrEqual(0)
      expect(state.x[id]! + piece.frame.width).toBeLessThanOrEqual(bounds.w)
      expect(state.y[id]! + piece.frame.height).toBeLessThanOrEqual(bounds.h)
    }
  })

  it('is deterministic for a given seed', () => {
    const build = makeTestBuild(4, 4, 50)
    const bounds = { w: 800, h: 600 }

    const stateA = createPuzzleState(build)
    scatterPieces(stateA, bounds, makeRng(42, 'scatter-test'))

    const stateB = createPuzzleState(build)
    scatterPieces(stateB, bounds, makeRng(42, 'scatter-test'))

    expect(Array.from(stateA.x)).toEqual(Array.from(stateB.x))
    expect(Array.from(stateA.y)).toEqual(Array.from(stateB.y))
  })
})

describe('isSolved', () => {
  it('is false when pieces are still in separate clusters', () => {
    const build = makeTestBuild(2, 2, 100)
    const state = createPuzzleState(build)
    const clusters = createClusterIndex(state.parent)

    expect(isSolved(state, clusters)).toBe(false)
  })

  it('is true once every piece shares one root', () => {
    const build = makeTestBuild(2, 2, 100)
    const state = createPuzzleState(build)
    const clusters = createClusterIndex(state.parent)

    clusters.union(0, 1)
    clusters.union(1, 2)
    clusters.union(2, 3)

    expect(isSolved(state, clusters)).toBe(true)
  })
})
