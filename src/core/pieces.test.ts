import { describe, it, expect } from 'vitest'
import { chooseGrid, buildLattice, gridOptions, vertexAt, type Grid, type Point } from './lattice'
import { buildEdges, horizontalEdge, verticalEdge, type EdgeSet } from './edges'
import { warpLattice } from './warp'
import { cellPath, cellPaths } from './pieces'

const SEED = 20260818

const ASPECTS = [
  { name: '1:1 square', w: 1000, h: 1000 },
  { name: '4:3 landscape', w: 4000, h: 3000 },
  { name: '16:9 wide', w: 1920, h: 1080 },
  { name: '3:1 panorama', w: 6000, h: 2000 },
  { name: '3:4 portrait', w: 3000, h: 4000 },
]

// Shoelace. Walking the outline and summing the cross product of each edge against the origin totals twice the signed area.
// Written out here rather than imported, on purpose. A test that reuses the code it is checking proves only that the code agrees with itself.
function polygonArea(path: readonly Point[]): number {
  let twice = 0
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!
    const b = path[(i + 1) % path.length]!
    twice += a.x * b.y - b.x * a.y
  }
  return Math.abs(twice) / 2
}

// The straight edged case, which is what 2.5 produced before tabs existed.
function squareEdges(grid: Grid) {
  return buildEdges(buildLattice(grid), SEED, { size: 0 })
}

function tabbedEdges(grid: Grid) {
  return buildEdges(buildLattice(grid), SEED)
}

describe('cellPath', () => {
  // The same worked example as vertexAt: a 3 by 2 puzzle, six pieces, twelve vertices, stride 4.
  const worked: Grid = {
    cols: 3,
    rows: 2,
    pieceCount: 6,
    imageWidth: 300,
    imageHeight: 200,
    cellWidth: 100,
    cellHeight: 100,
  }

  it('walks the four corners clockwise from the top left when edges are straight', () => {
    const piece = cellPath(squareEdges(worked), 1, 0)

    expect(piece.path).toEqual([
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 100, y: 100 },
    ])
  })

  // The piece grid is cols wide. The lattice is cols + 1 wide. Using the lattice stride here numbers piece (2, 1) as 6 instead of 5, which collides with nothing and so would never crash.
  it('numbers pieces on the piece grid, not the lattice stride', () => {
    const edges = squareEdges(worked)

    expect(cellPath(edges, 0, 0).id).toBe(0)
    expect(cellPath(edges, 2, 0).id).toBe(2)
    expect(cellPath(edges, 0, 1).id).toBe(3)
    expect(cellPath(edges, 2, 1).id).toBe(5)
  })

  // A pixel of slack, because bbox stores width rather than max x and `minX + (maxX - minX)` does not always land back on maxX in floating point.
  // The failure this guards against is a bbox that misses the path by a real distance, not by an ulp.
  it('wraps the path in the bounding box', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const slack = 1e-9
    let inspected = 0

    for (const edges of [squareEdges(grid), tabbedEdges(grid)]) {
      for (const piece of cellPaths(edges)) {
        for (const point of piece.path) {
          expect(point.x, `piece ${piece.id}`).toBeGreaterThanOrEqual(piece.bbox.x - slack)
          expect(point.x, `piece ${piece.id}`).toBeLessThanOrEqual(piece.bbox.x + piece.bbox.width + slack)
          expect(point.y, `piece ${piece.id}`).toBeGreaterThanOrEqual(piece.bbox.y - slack)
          expect(point.y, `piece ${piece.id}`).toBeLessThanOrEqual(piece.bbox.y + piece.bbox.height + slack)
          inspected++
        }
      }
    }

    expect(inspected).toBeGreaterThan(50000)
  })

  // solved is the grid origin, which is where the top edge starts, not the top left of the bbox.
  // They coincide only while edges are straight. A tab hanging off the top or left separates them, and PieceDef.anchor in the bake is exactly that difference.
  it('puts solved on the top left lattice vertex, even when a tab moves the bbox', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const lattice = buildLattice(grid)
    const edges = buildEdges(lattice, SEED)

    let separated = 0

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const piece = cellPath(edges, col, row)
        expect(piece.solved, `piece ${col},${row}`).toEqual(vertexAt(lattice, col, row))

        if (piece.bbox.x < piece.solved.x || piece.bbox.y < piece.solved.y) separated++
      }
    }

    // If this were zero, no tab was overhanging the top or left of any piece and the distinction would be untested.
    expect(separated).toBeGreaterThan(100)
  })

  it('grows the bounding box past the cell wherever a tab overhangs', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const square = cellPaths(squareEdges(grid))
    const tabbed = cellPaths(tabbedEdges(grid))

    let grown = 0
    for (let i = 0; i < square.length; i++) {
      const before = square[i]!.bbox
      const after = tabbed[i]!.bbox

      expect(after.width, `piece ${i} width`).toBeGreaterThanOrEqual(before.width - 1e-9)
      expect(after.height, `piece ${i} height`).toBeGreaterThanOrEqual(before.height - 1e-9)

      if (after.width > before.width + 1e-9 || after.height > before.height + 1e-9) grown++
    }

    expect(grown).toBeGreaterThan(400)
  })

  // The gate for this step, stated on the data.
  //
  // Piece A's bottom run must be the stored edge reversed, and piece B's top run must be the same stored edge forwards.
  // Exact equality, not approximate. Two pieces generating identically shaped edges separately would differ by floating point and would not fit.
  it('shares an edge with each neighbour, identical and reversed', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const edges = tabbedEdges(grid)
    let inspected = 0

    for (let row = 0; row + 1 < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const shared = horizontalEdge(edges, col, row + 1)
        const where = `piece ${col},${row}`

        const { bottomStart, bottomEnd } = sideRanges(edges, col, row)
        const mine = cellPath(edges, col, row).path.slice(bottomStart, bottomEnd + 1)
        expect(mine, `${where} bottom run`).toEqual([...shared].reverse())

        const theirs = cellPath(edges, col, row + 1).path.slice(0, shared.length)
        expect(theirs, `${where} neighbour's top run`).toEqual(shared)

        inspected++
      }
    }

    expect(inspected).toBeGreaterThan(400)
  })

  it('refuses cells outside the puzzle', () => {
    const edges = squareEdges(worked)

    // The lattice has a vertex at column 3, but the puzzle has no piece there. Off by one between the two grids is the mistake this guards.
    expect(() => cellPath(edges, 3, 0)).toThrow()
    expect(() => cellPath(edges, 0, 2)).toThrow()
    expect(() => cellPath(edges, -1, 0)).toThrow()
  })
})

// Where each side sits inside a piece's path.
//
// The path is top, then right without its leading point, then bottom reversed without its leading point, then left reversed without either end.
// The offsets have to be computed rather than assumed, because edges do not all hold the same number of points: a border edge is two, a tabbed one is 41.
function sideRanges(edges: EdgeSet, col: number, row: number): { bottomStart: number; bottomEnd: number } {
  const top = horizontalEdge(edges, col, row)
  const right = verticalEdge(edges, col + 1, row)
  const bottom = horizontalEdge(edges, col, row + 1)

  const bottomStart = top.length - 1 + (right.length - 1)

  return { bottomStart, bottomEnd: bottomStart + (bottom.length - 1) }
}

describe('cellPaths', () => {
  it('returns every piece exactly once, in id order', () => {
    const grid = chooseGrid(600, 1600, 1200)
    const pieces = cellPaths(tabbedEdges(grid))

    expect(pieces).toHaveLength(grid.pieceCount)
    pieces.forEach((piece, index) => {
      expect(piece.id).toBe(index)
    })

    expect(new Set(pieces.map((piece) => `${piece.col},${piece.row}`)).size).toBe(grid.pieceCount)
  })

  // The strongest test in the suite, and it needed no changes to survive tabs.
  //
  // A knob adds to one piece exactly the area its socket removes from the other, so the total is still the image.
  // That can only hold if every shared edge is literally the same array of points. Generate an edge twice, even identically shaped, and floating point alone breaks this.
  it('covers the image exactly, with no gaps and no overlaps', () => {
    let inspected = 0

    for (const aspect of ASPECTS) {
      for (const { band, grid } of gridOptions(aspect.w, aspect.h)) {
        for (const [label, edges] of [['straight', squareEdges(grid)], ['tabbed', tabbedEdges(grid)]] as const) {
          const pieces = cellPaths(edges)
          const total = pieces.reduce((sum, piece) => sum + polygonArea(piece.path), 0)
          const imageArea = grid.imageWidth * grid.imageHeight

          expect(Math.abs(total - imageArea) / imageArea, `${label} ${band.name} on ${aspect.name}`).toBeLessThan(1e-12)
          inspected += pieces.length
        }
      }
    }

    expect(inspected).toBeGreaterThan(6000)
  })

  // The lab exposes tab size and variance as sliders, so every value they can reach has to be one where the cut still holds together.
  //
  // Coverage is the right check for that. A tab large enough to poke out the far side of its neighbour makes two pieces overlap, and one large enough to collide with its own perpendicular edge makes the outline self intersect.
  // Both change the shoelace answer, so the total drifts off the image area either way.
  it('still covers the image exactly across every setting the lab can reach', () => {
    const grid = chooseGrid(600, 1920, 1080)
    const imageArea = grid.imageWidth * grid.imageHeight
    let inspected = 0

    for (const amplitude of [0, 0.4]) {
      const lattice = warpLattice(buildLattice(grid), grid, SEED, { amplitude })

      for (const size of [0, 0.5, 1, 1.5]) {
        for (const variance of [0, 0.5]) {
          const pieces = cellPaths(buildEdges(lattice, SEED, { size, variance }))
          const total = pieces.reduce((sum, piece) => sum + polygonArea(piece.path), 0)

          expect(Math.abs(total - imageArea) / imageArea, `warp ${amplitude}, size ${size}, variance ${variance}`).toBeLessThan(1e-12)
          inspected++
        }
      }
    }

    expect(inspected).toBe(16)
  })

  // Same property on a warped lattice, since the warp moves every corner the edges are built from.
  it('covers a warped image exactly too', () => {
    const grid = chooseGrid(600, 1920, 1080)
    const warped = warpLattice(buildLattice(grid), grid, SEED)
    const pieces = cellPaths(buildEdges(warped, SEED))

    const total = pieces.reduce((sum, piece) => sum + polygonArea(piece.path), 0)
    const imageArea = grid.imageWidth * grid.imageHeight

    expect(Math.abs(total - imageArea) / imageArea).toBeLessThan(1e-12)
    expect(pieces.length).toBe(grid.pieceCount)
  })
})
