import { describe, it, expect } from 'vitest'
import { createPuzzleState } from './puzzle'
import { createClusterIndex } from './unionFind'
import { applyCommand, createCommandContext, findSnapTargets } from './commands'
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

describe('snapping on drop', () => {
  it('does not merge while still moving, only stopping near a match is not enough', () => {
    const { state, clusters, ctx } = setup()
    // Piece 1 sits at solved (100, 0). Move it to 15px off, inside the 20px snap distance of neighbour
    // 2, but never drop. This is exactly the "passed near a matching piece on the way somewhere else"
    // case that used to merge unintentionally.
    state.x[1] = 115
    state.y[1] = 0

    applyCommand(ctx, { type: 'PickUp', pieceId: 1, actorId: 1 })
    const merges = applyCommand(ctx, { type: 'Move', actorId: 1, dx: 0, dy: 0 })

    expect(merges).toEqual([])
    expect(clusters.find(1)).not.toBe(clusters.find(2))
    // Position is not corrected either, nothing snapped, so nothing to correct.
    expect(state.x[1]).toBeCloseTo(115)
  })

  it('merges on drop when a real neighbour is within snap distance', () => {
    const { state, clusters, ctx } = setup()
    // Piece 1's neighbours are [null, 2, 4, 0] (N, E, S, W). West (0) already shares a cluster, and
    // south (4) is moved out of range, so east (piece 2) is the only real candidate left.
    clusters.union(0, 1)
    state.x[4] = 9999
    state.x[1] = 115
    state.y[1] = 0

    applyCommand(ctx, { type: 'PickUp', pieceId: 1, actorId: 1 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 0, dy: 0 })
    const merges = applyCommand(ctx, { type: 'Drop', actorId: 1 })

    expect(clusters.find(1)).toBe(clusters.find(2))
    // Snapping corrects position to the exact rigid offset, not just close.
    expect(state.x[1]).toBeCloseTo(100)
    expect(state.y[1]).toBeCloseTo(0)
    // render/board.ts rebakes exactly the pieces named here off this return value, so the ids matter,
    // not just that something merged.
    expect(merges).toEqual([{ type: 'Merge', a: 1, b: 2 }])
  })

  it('does not merge a real neighbour still outside snap distance', () => {
    const { state, clusters, ctx } = setup()
    state.x[1] = 150
    state.y[1] = 0

    applyCommand(ctx, { type: 'PickUp', pieceId: 1, actorId: 1 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 0, dy: 0 })
    const merges = applyCommand(ctx, { type: 'Drop', actorId: 1 })

    expect(clusters.find(0)).not.toBe(clusters.find(1))
    expect(merges).toEqual([])
  })

  it('never merges two pieces that are not real grid neighbours, however close', () => {
    const { state, clusters, ctx } = setup()
    // Piece 8 (row 2, col 2) is diagonal to piece 4 (row 1, col 1), not a neighbour on this grid.
    state.x[8] = state.x[4]! + 5
    state.y[8] = state.y[4]! + 5

    applyCommand(ctx, { type: 'PickUp', pieceId: 8, actorId: 1 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 0, dy: 0 })
    applyCommand(ctx, { type: 'Drop', actorId: 1 })

    expect(clusters.find(4)).not.toBe(clusters.find(8))
  })

  it('connects to every matching neighbour in one drop, not just the first found', () => {
    const { clusters, ctx } = setup()
    clusters.union(0, 1)

    // Piece 1's neighbours are 2 (east) and 4 (south), both already sitting exactly at snap distance at
    // once, the way the last piece dropped into a gap between two already-placed neighbours would find
    // both real. A single pick up, move, drop should connect it to both, the way setting a real piece
    // into a hole surrounded on more than one side would.
    applyCommand(ctx, { type: 'PickUp', pieceId: 1, actorId: 1 })
    applyCommand(ctx, { type: 'Move', actorId: 1, dx: 0, dy: 0 })
    const merges = applyCommand(ctx, { type: 'Drop', actorId: 1 })

    expect(clusters.membersOf(1)).toEqual(new Set([0, 1, 2, 4]))
    expect(merges).toEqual([
      { type: 'Merge', a: 1, b: 2 },
      { type: 'Merge', a: 1, b: 4 },
    ])
  })
})

describe('findSnapTargets', () => {
  it('previews a single match trySnap would take, without merging or moving anything', () => {
    const { state, clusters, ctx } = setup()
    clusters.union(0, 1)
    // Piece 4 (south) moved far out of range, leaving only piece 2 (east) as a real candidate.
    state.x[4] = 9999
    state.x[1] = 115
    state.y[1] = 0

    const found = findSnapTargets(ctx, 1)

    expect(found).toEqual([{ neighborId: 2, target: { x: 100, y: 0 } }])
    // Purely a query: nothing merged and nothing moved just from asking.
    expect(clusters.find(1)).not.toBe(clusters.find(2))
    expect(state.x[1]).toBe(115)
  })

  it('previews more than one match at once, when more than one neighbour is close enough', () => {
    const { clusters, ctx } = setup()
    // West (piece 0) already shares a cluster with piece 1, so only east (2) and south (4) are real
    // candidates, both sitting exactly at snap distance already.
    clusters.union(0, 1)

    // Both targets land on piece 1's own solved position: each neighbour sits exactly at its own solved
    // spot, so "correct relative to neighbour 2" and "correct relative to neighbour 4" are the same
    // point here, which is exactly why a real corner or interior piece can match several sides at once.
    expect(findSnapTargets(ctx, 1)).toEqual([
      { neighborId: 2, target: { x: 100, y: 0 } },
      { neighborId: 4, target: { x: 100, y: 0 } },
    ])
  })

  it('returns an empty list when nothing is close enough, same as trySnap would find', () => {
    const { state, ctx } = setup()
    state.x[1] = 150
    state.y[1] = 0

    expect(findSnapTargets(ctx, 1)).toEqual([])
  })
})
