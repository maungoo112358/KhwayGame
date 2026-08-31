import { describe, it, expect } from 'vitest'
import { createPuzzleState } from './puzzle'
import { createClusterIndex } from './unionFind'
import { applyCommand, createCommandContext } from './commands'
import { makeTestBuild } from './testFixtures'

// 3 by 3 grid, cell 100, so adjacent solved positions are exactly 100 apart on one axis. snapDistance 20
// is comfortably inside "still touching" and comfortably outside "on the far side of the piece".
function setup() {
  const build = makeTestBuild(3, 3, 100)
  const state = createPuzzleState(build)
  const clusters = createClusterIndex(state.parent)
  const ctx = createCommandContext(state, clusters, 20)
  return { state, clusters, ctx }
}

describe('PickUp, Move, Drop', () => {
  it('moves only the picked up piece when it has no cluster mates', () => {
    const { state, ctx } = setup()

    applyCommand(ctx, { type: 'PickUp', pieceId: 4, actorId: 1 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 30, dy: 5 })

    expect(state.x[4]).toBeCloseTo(100 + 30)
    expect(state.y[4]).toBeCloseTo(100 + 5)
    // Piece 0, unrelated, untouched.
    expect(state.x[0]).toBe(0)
    expect(state.y[0]).toBe(0)
  })

  it('marks every member of the held cluster and clears it on drop', () => {
    const { state, clusters, ctx } = setup()
    clusters.union(0, 1)

    applyCommand(ctx, { type: 'PickUp', pieceId: 0, actorId: 7 })
    expect(state.heldBy[0]).toBe(7)
    expect(state.heldBy[1]).toBe(7)

    applyCommand(ctx, { type: 'Drop', actorId: 7 })
    expect(state.heldBy[0]).toBe(-1)
    expect(state.heldBy[1]).toBe(-1)
  })

  it('ignores Move and Drop from an actor holding nothing', () => {
    const { state, ctx } = setup()

    applyCommand(ctx, { type: 'Move', actorId: 99, dx: 100, dy: 100 })
    applyCommand(ctx, { type: 'Drop', actorId: 99 })

    expect(state.x[0]).toBe(0)
  })

  it('moves every member of an already merged cluster by the same delta, offsets preserved', () => {
    const { state, clusters, ctx } = setup()
    clusters.union(0, 1)

    applyCommand(ctx, { type: 'PickUp', pieceId: 0, actorId: 1 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 40, dy: -10 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 5, dy: 5 })

    expect(state.x[0]).toBeCloseTo(45)
    expect(state.y[0]).toBeCloseTo(-5)
    // Piece 1 started 100px to the right of piece 0 (col 1 vs col 0), that offset must survive the move.
    expect(state.x[1]).toBeCloseTo(100 + 45)
    expect(state.y[1]).toBeCloseTo(-5)
  })
})

describe('snapping on move', () => {
  it('merges when a real neighbour comes within snap distance', () => {
    const { state, clusters, ctx } = setup()
    // Piece 1 sits at solved (100, 0). trySnap checks its neighbours in N, E, S, W order and stops at
    // the first match, and piece 1's neighbours are [null, 2, 4, 0], so east (piece 2) is the one that
    // actually resolves here, not west (piece 0). Move piece 1 to 15px off its solved position, inside
    // the 20px snap distance, with piece 2 left untouched at its own solved position.
    state.x[1] = 115
    state.y[1] = 0

    applyCommand(ctx, { type: 'PickUp', pieceId: 1, actorId: 1 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 0, dy: 0 })

    expect(clusters.find(1)).toBe(clusters.find(2))
    // Snapping corrects position to the exact rigid offset, not just close.
    expect(state.x[1]).toBeCloseTo(100)
    expect(state.y[1]).toBeCloseTo(0)
  })

  it('does not merge a real neighbour still outside snap distance', () => {
    const { state, clusters, ctx } = setup()
    state.x[1] = 150
    state.y[1] = 0

    applyCommand(ctx, { type: 'PickUp', pieceId: 1, actorId: 1 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 0, dy: 0 })

    expect(clusters.find(0)).not.toBe(clusters.find(1))
  })

  it('never merges two pieces that are not real grid neighbours, however close', () => {
    const { state, clusters, ctx } = setup()
    // Piece 8 (row 2, col 2) is diagonal to piece 4 (row 1, col 1), not a neighbour on this grid.
    state.x[8] = state.x[4]! + 5
    state.y[8] = state.y[4]! + 5

    applyCommand(ctx, { type: 'PickUp', pieceId: 8, actorId: 1 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 0, dy: 0 })

    expect(clusters.find(4)).not.toBe(clusters.find(8))
  })

  it('grows one cluster through two separate pieces snapping in, one tick at a time', () => {
    const { clusters, ctx } = setup()
    clusters.union(0, 1)

    // trySnap only acts on the anchor's own neighbours and stops at the first match, same as a real
    // pointer move tick. Piece 1's neighbours are 2 (east) and 4 (south); with nothing yet moved, both
    // sit exactly at the distance a snap already accepts, so each Move call resolves one of them.
    applyCommand(ctx, { type: 'PickUp', pieceId: 1, actorId: 1 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 0, dy: 0 })
    expect(clusters.membersOf(1)).toEqual(new Set([0, 1, 2]))

    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 0, dy: 0 })
    expect(clusters.membersOf(1)).toEqual(new Set([0, 1, 2, 4]))
  })
})
