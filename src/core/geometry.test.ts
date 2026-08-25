import { describe, it, expect } from 'vitest'
import { chooseGrid, buildLattice, type Grid } from './lattice'
import { warpLattice } from './warp'
import { buildEdges } from './edges'
import { cellPaths } from './pieces'
import { createWarpedGridGeometry, isEdgePiece } from './geometry'

const SEED = 20260818

// The worked example again: a 3 by 2 puzzle. Ids run 0 to 5 left to right, top to bottom.
//
//   0  1  2
//   3  4  5
const worked: Grid = {
  cols: 3,
  rows: 2,
  pieceCount: 6,
  imageWidth: 300,
  imageHeight: 200,
  cellWidth: 100,
  cellHeight: 100,
}

const [NORTH, EAST, SOUTH, WEST] = [0, 1, 2, 3]

describe('createWarpedGridGeometry', () => {
  it('publishes one piece per cell, in id order', () => {
    const provider = createWarpedGridGeometry({ grid: worked, seed: SEED })
    const pieces = provider.pieces()

    expect(provider.pieceCount).toBe(6)
    expect(provider.imageWidth).toBe(300)
    expect(provider.imageHeight).toBe(200)
    expect(pieces).toHaveLength(6)
    pieces.forEach((piece, index) => expect(piece.id).toBe(index))
  })

  it('names the four neighbours in north, east, south, west order', () => {
    const pieces = createWarpedGridGeometry({ grid: worked, seed: SEED }).pieces()

    // Top left: nothing north or west, piece 1 east, piece 3 south.
    expect(pieces[0]!.neighbors).toEqual([null, 1, 3, null])
    // Top middle: neighbours on three sides.
    expect(pieces[1]!.neighbors).toEqual([null, 2, 4, 0])
    // Bottom right: nothing east or south.
    expect(pieces[5]!.neighbors).toEqual([2, null, null, 4])
    // Bottom left.
    expect(pieces[3]!.neighbors).toEqual([0, 4, null, null])
  })

  // Catches a transposed or off by one neighbour table, which would otherwise show up much later as snapping that works in one direction only.
  it('agrees with itself in both directions', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const pieces = createWarpedGridGeometry({ grid, seed: SEED }).pieces()
    let inspected = 0

    for (const piece of pieces) {
      const [north, east, south, west] = piece.neighbors

      if (north !== null) expect(pieces[north]!.neighbors[SOUTH], `piece ${piece.id} north`).toBe(piece.id)
      if (south !== null) expect(pieces[south]!.neighbors[NORTH], `piece ${piece.id} south`).toBe(piece.id)
      if (east !== null) expect(pieces[east]!.neighbors[WEST], `piece ${piece.id} east`).toBe(piece.id)
      if (west !== null) expect(pieces[west]!.neighbors[EAST], `piece ${piece.id} west`).toBe(piece.id)

      inspected++
    }

    expect(inspected).toBeGreaterThan(400)
  })

  // A null must mean the puzzle ends, not a bug. Interior pieces have four, corners have two, and the totals are fixed by the grid size.
  it('puts a null exactly where the puzzle ends', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const pieces = createWarpedGridGeometry({ grid, seed: SEED }).pieces()

    let edgePieces = 0
    for (const piece of pieces) {
      const onBorder = piece.col === 0 || piece.col === grid.cols - 1 || piece.row === 0 || piece.row === grid.rows - 1
      const hasNull = piece.neighbors.some((neighbor) => neighbor === null)

      expect(hasNull, `piece ${piece.col},${piece.row}`).toBe(onBorder)
      if (onBorder) edgePieces++
    }

    // The border of a cols by rows grid, counted without double counting the corners.
    expect(edgePieces).toBe(2 * grid.cols + 2 * grid.rows - 4)
  })

  // The seam must not change the geometry, only hide where it came from.
  it('produces exactly what the pipeline behind it produces', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const warp = { amplitude: 0.2 }
    const tabs = { size: 0.8 }

    const throughSeam = createWarpedGridGeometry({ grid, seed: SEED, warp, tabs }).pieces()
    const byHand = cellPaths(buildEdges(warpLattice(buildLattice(grid), grid, SEED, warp), SEED, tabs))

    expect(throughSeam).toHaveLength(byHand.length)
    throughSeam.forEach((piece, index) => {
      expect(piece.path, `piece ${index}`).toEqual(byHand[index]!.path)
      expect(piece.bbox, `piece ${index}`).toEqual(byHand[index]!.bbox)
      expect(piece.solved, `piece ${index}`).toEqual(byHand[index]!.solved)
    })
  })

  it('gives the same geometry every time for a seed, and different for another', () => {
    const grid = chooseGrid(500, 1600, 1200)

    const first = createWarpedGridGeometry({ grid, seed: SEED }).pieces()
    const same = createWarpedGridGeometry({ grid, seed: SEED }).pieces()
    const other = createWarpedGridGeometry({ grid, seed: SEED + 1 }).pieces()

    expect(first.map((piece) => piece.path)).toEqual(same.map((piece) => piece.path))
    expect(first.map((piece) => piece.path)).not.toEqual(other.map((piece) => piece.path))
  })

  it('passes its options through to the warp and the tabs', () => {
    const grid = chooseGrid(500, 1600, 1200)

    const flat = createWarpedGridGeometry({ grid, seed: SEED, warp: { amplitude: 0 }, tabs: { size: 0 } }).pieces()

    // Amplitude zero and tab size zero together are the unwarped, straight edged cut, so every piece is a four cornered quad on the ruled grid.
    for (const piece of flat) {
      expect(piece.path, `piece ${piece.id}`).toHaveLength(4)
    }

    expect(flat[0]!.path[0]).toEqual({ x: 0, y: 0 })
  })
})

describe('isEdgePiece', () => {
  it('is false when every neighbour exists', () => {
    expect(isEdgePiece([1, 2, 3, 4])).toBe(false)
  })

  it('is true when exactly one neighbour is missing, whichever side', () => {
    expect(isEdgePiece([null, 2, 3, 4])).toBe(true)
    expect(isEdgePiece([1, null, 3, 4])).toBe(true)
    expect(isEdgePiece([1, 2, null, 4])).toBe(true)
    expect(isEdgePiece([1, 2, 3, null])).toBe(true)
  })

  it('is true for a corner, two missing neighbours', () => {
    expect(isEdgePiece([null, 2, 3, null])).toBe(true)
  })

  it('is true for the smallest possible puzzle, every neighbour missing', () => {
    expect(isEdgePiece([null, null, null, null])).toBe(true)
  })
})
