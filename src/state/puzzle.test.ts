import { describe, it, expect } from 'vitest'
import { createPuzzleState, scatterBounds, scatterPieces, centerPlacement, isSolved } from './puzzle'
import { createClusterIndex } from './unionFind'
import { makeRng, type PuzzleBuild } from '../core'
import { makeTestBuild } from './testFixtures'

// Every piece in makeTestBuild's own fixture is identically sized, which is exactly what let the shelf
// packing bug hide from every test built on it: a placement algorithm that assumes uniform piece size
// has nothing to disagree with there. Real baked pieces vary, tab overhang runs up to roughly 40% over
// nominal per docs/architecture.md. This gives each piece a different size, up to 60% over base, deliberately
// more variance than the real worst case, so a test built on it is a harder case than production, not an
// easier one.
function withVariedFrameSizes(build: PuzzleBuild, baseSize: number): PuzzleBuild {
  return {
    ...build,
    pieces: build.pieces.map((piece, i) => ({
      ...piece,
      frame: { ...piece.frame, width: baseSize * (1 + (i % 5) * 0.15), height: baseSize * (1 + ((i + 2) % 5) * 0.15) },
    })),
  }
}

function overlaps(state: ReturnType<typeof createPuzzleState>, a: number, b: number): boolean {
  const framA = state.pieces[a]!.frame
  const framB = state.pieces[b]!.frame
  return (
    state.x[a]! < state.x[b]! + framB.width &&
    state.x[a]! + framA.width > state.x[b]! &&
    state.y[a]! < state.y[b]! + framB.height &&
    state.y[a]! + framA.height > state.y[b]!
  )
}

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
  it('keeps every piece within the area it reports having used', () => {
    const build = makeTestBuild(4, 4, 50)
    const state = createPuzzleState(build)
    const rng = makeRng(1, 'scatter-test')

    const used = scatterPieces(state, { w: 800, h: 600 }, rng)

    for (let id = 0; id < state.pieceCount; id++) {
      const piece = state.pieces[id]!
      expect(state.x[id]).toBeGreaterThanOrEqual(0)
      expect(state.y[id]).toBeGreaterThanOrEqual(0)
      expect(state.x[id]! + piece.frame.width).toBeLessThanOrEqual(used.w)
      expect(state.y[id]! + piece.frame.height).toBeLessThanOrEqual(used.h)
    }
  })

  it('never lets a row grow past the requested width', () => {
    const build = makeTestBuild(4, 4, 50)
    const state = createPuzzleState(build)
    const rng = makeRng(1, 'scatter-test')

    const used = scatterPieces(state, { w: 800, h: 600 }, rng)

    // Shelf packing wraps to a new row rather than exceeding the requested width, height is allowed to
    // grow as far as it needs to instead, see PlacementBounds.
    expect(used.w).toBeLessThanOrEqual(800)
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

  // The first bug this was written to catch: pieces scattered into bake.working's own zero-slack
  // footprint (solved pieces tile it edge to edge) landed stacked on top of each other, found by hand
  // in a real browser, not by a test that only checked bounds compliance. This checks the real property.
  it('does not overlap any two pieces when given scatterBounds room', () => {
    const build = makeTestBuild(6, 6, 50)
    const state = createPuzzleState(build)
    const bounds = scatterBounds({ w: 6 * 50, h: 6 * 50 })
    const rng = makeRng(7, 'overlap-test')

    scatterPieces(state, bounds, rng)

    let comparisons = 0
    for (let i = 0; i < state.pieceCount; i++) {
      for (let j = i + 1; j < state.pieceCount; j++) {
        expect(overlaps(state, i, j), `piece ${i} vs piece ${j}`).toBe(false)
        comparisons++
      }
    }

    // A coverage check on the check itself, same house rule as core/atlas.test.ts's overlap test: this
    // must actually have compared a real number of pairs, not passed by inspecting nothing.
    expect(comparisons).toBeGreaterThan(500)
  })

  // The second bug, found after the first fix: a grid of equal sized cells, sized from piece count
  // alone, assumes every piece is the same size. Real baked pieces are not, and a bigger-than-average
  // piece spilled into its neighbour's cell. Every test above uses makeTestBuild's own uniformly sized
  // pieces, which cannot exercise this, this one deliberately cannot avoid it.
  it('does not overlap any two pieces when piece sizes vary, the way real baked pieces do', () => {
    const build = withVariedFrameSizes(makeTestBuild(10, 10, 50), 50)
    const state = createPuzzleState(build)
    const bounds = scatterBounds({ w: 10 * 50, h: 10 * 50 })
    const rng = makeRng(11, 'overlap-varied-test')

    scatterPieces(state, bounds, rng)

    let comparisons = 0
    for (let i = 0; i < state.pieceCount; i++) {
      for (let j = i + 1; j < state.pieceCount; j++) {
        expect(overlaps(state, i, j), `piece ${i} vs piece ${j}`).toBe(false)
        comparisons++
      }
    }

    expect(comparisons).toBeGreaterThan(4000)
  })
})

describe('centerPlacement', () => {
  it('centers the used block within a bigger tableBounds', () => {
    const build = makeTestBuild(4, 4, 50)
    const state = createPuzzleState(build)
    const rng = makeRng(1, 'scatter-test')

    const used = scatterPieces(state, { w: 800, h: 600 }, rng)
    const before = { x: Array.from(state.x), y: Array.from(state.y) }
    const tableBounds = { w: used.w + 400, h: used.h + 200 }

    centerPlacement(state, tableBounds, used)

    const offsetX = (tableBounds.w - used.w) / 2
    const offsetY = (tableBounds.h - used.h) / 2
    for (let id = 0; id < state.pieceCount; id++) {
      expect(state.x[id]).toBeCloseTo(before.x[id]! + offsetX)
      expect(state.y[id]).toBeCloseTo(before.y[id]! + offsetY)
    }
  })

  it('leaves positions unchanged when tableBounds equals the used area exactly', () => {
    const build = makeTestBuild(4, 4, 50)
    const state = createPuzzleState(build)
    const rng = makeRng(1, 'scatter-test')

    const used = scatterPieces(state, { w: 800, h: 600 }, rng)
    const before = { x: Array.from(state.x), y: Array.from(state.y) }

    centerPlacement(state, used, used)

    expect(Array.from(state.x)).toEqual(before.x)
    expect(Array.from(state.y)).toEqual(before.y)
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
