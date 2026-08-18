import { describe, it, expect } from 'vitest'
import {
  chooseGrid,
  buildLattice,
  vertexAt,
  gridOptions,
  cellPath,
  cellPaths,
  PIECE_COUNT_BANDS,
  type Grid,
  type Point,
} from './lattice'

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

const ASPECTS = [
  { name: '1:1 square', w: 1000, h: 1000 },
  { name: '4:3 landscape', w: 4000, h: 3000 },
  { name: '16:9 wide', w: 1920, h: 1080 },
  { name: '3:1 panorama', w: 6000, h: 2000 },
  { name: '3:4 portrait', w: 3000, h: 4000 },
]

const TARGETS = [50, 100, 500, 1000]

describe('chooseGrid', () => {
  // Rounding two numbers to integers costs a fixed amount, so the relative error shrinks as the piece count grows.
  // Small counts are only used in tests. The counts we actually ship, 500 and up, land within a couple of percent.
  it('lands near the requested piece count', () => {
    for (const aspect of ASPECTS) {
      for (const target of TARGETS) {
        const grid = chooseGrid(target, aspect.w, aspect.h)
        const error = Math.abs(grid.pieceCount - target) / target
        const allowed = target >= 500 ? 0.05 : 0.12

        expect(error, `${aspect.name} at ${target} gave ${grid.pieceCount}`).toBeLessThan(allowed)
      }
    }
  })

  it('keeps cells near square', () => {
    for (const aspect of ASPECTS) {
      for (const target of TARGETS) {
        const grid = chooseGrid(target, aspect.w, aspect.h)
        const cellAspect = grid.cellWidth / grid.cellHeight
        const allowed = target >= 500 ? 0.05 : 0.12

        expect(Math.abs(cellAspect - 1), `${aspect.name} at ${target}`).toBeLessThan(allowed)
      }
    }
  })

  // Catches an axis flip, which would otherwise show up much later as a sideways puzzle.
  it('orients the grid to the image', () => {
    expect(chooseGrid(1000, 4000, 3000).cols).toBeGreaterThan(chooseGrid(1000, 4000, 3000).rows)
    expect(chooseGrid(1000, 3000, 4000).rows).toBeGreaterThan(chooseGrid(1000, 3000, 4000).cols)

    const square = chooseGrid(1000, 2000, 2000)
    expect(square.cols).toBe(square.rows)
  })

  it('reports the true piece count, not the requested one', () => {
    const grid = chooseGrid(1000, 4000, 3000)
    expect(grid.pieceCount).toBe(grid.cols * grid.rows)
    expect(grid.pieceCount).not.toBe(1000)
  })

  it('never drops below two pieces per side', () => {
    const grid = chooseGrid(1, 4000, 3000)
    expect(grid.cols).toBeGreaterThanOrEqual(2)
    expect(grid.rows).toBeGreaterThanOrEqual(2)
  })

  it('rejects invalid input rather than producing NaN', () => {
    // Without this guard a zero height gives an infinite aspect, and buildLattice would loop forever.
    expect(() => chooseGrid(1000, 4000, 0)).toThrow()
    expect(() => chooseGrid(1000, 0, 3000)).toThrow()
    expect(() => chooseGrid(0, 4000, 3000)).toThrow()
    expect(() => chooseGrid(1000, 4000, Number.NaN)).toThrow()
  })
})

describe('buildLattice', () => {
  it('holds one more vertex than pieces in each direction', () => {
    for (const aspect of ASPECTS) {
      const grid = chooseGrid(1000, aspect.w, aspect.h)
      const lattice = buildLattice(grid)

      expect(lattice.stride).toBe(grid.cols + 1)
      expect(lattice.points).toHaveLength((grid.cols + 1) * (grid.rows + 1))
    }
  })

  it('puts the outer corners exactly on the image corners', () => {
    const grid = chooseGrid(1000, 4000, 3000)
    const lattice = buildLattice(grid)

    // Exact equality on purpose. Stepping by cell size instead of scaling a fraction would land these a hair off.
    expect(vertexAt(lattice, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(vertexAt(lattice, grid.cols, 0)).toEqual({ x: 4000, y: 0 })
    expect(vertexAt(lattice, 0, grid.rows)).toEqual({ x: 0, y: 3000 })
    expect(vertexAt(lattice, grid.cols, grid.rows)).toEqual({ x: 4000, y: 3000 })
  })

  // Stepping by cell size instead of scaling a fraction drifts off the far corner for 339 of 2990 measured
  // (width, cols) combinations, by around 5e-13. One grid is not enough to catch it: cols 37 round trips
  // exactly while cols 15 and 19 do not, so this sweeps a range instead.
  it('lands exactly on the far corner for every grid size', () => {
    for (let cols = 2; cols <= 120; cols++) {
      const grid: Grid = {
        cols,
        rows: 3,
        pieceCount: cols * 3,
        imageWidth: 4000,
        imageHeight: 3000,
        cellWidth: 4000 / cols,
        cellHeight: 1000,
      }
      expect(vertexAt(buildLattice(grid), cols, 3).x, `cols ${cols}`).toBe(4000)
    }

    for (let rows = 2; rows <= 120; rows++) {
      const grid: Grid = {
        cols: 3,
        rows,
        pieceCount: rows * 3,
        imageWidth: 4000,
        imageHeight: 3000,
        cellWidth: 1000,
        cellHeight: 3000 / rows,
      }
      expect(vertexAt(buildLattice(grid), 3, rows).y, `rows ${rows}`).toBe(3000)
    }
  })

  it('spaces vertices evenly', () => {
    const grid = chooseGrid(1000, 4000, 3000)
    const lattice = buildLattice(grid)

    for (let col = 1; col <= grid.cols; col++) {
      const gap = vertexAt(lattice, col, 0).x - vertexAt(lattice, col - 1, 0).x
      expect(gap).toBeCloseTo(grid.cellWidth, 9)
    }

    for (let row = 1; row <= grid.rows; row++) {
      const gap = vertexAt(lattice, 0, row).y - vertexAt(lattice, 0, row - 1).y
      expect(gap).toBeCloseTo(grid.cellHeight, 9)
    }
  })
})

describe('vertexAt', () => {
  // The worked example: a 3 by 2 puzzle, six pieces, twelve vertices, stride 4.
  //
  //    0   1   2   3
  //    +---+---+---+
  //    | . | . | . |
  //    4   5   6   7
  //    +---+---+---+
  //    | . | . | . |
  //    8   9  10  11
  //    +---+---+---+
  const worked: Grid = {
    cols: 3,
    rows: 2,
    pieceCount: 6,
    imageWidth: 300,
    imageHeight: 200,
    cellWidth: 100,
    cellHeight: 100,
  }

  it('maps col and row onto the right flat index', () => {
    const lattice = buildLattice(worked)
    expect(lattice.stride).toBe(4)
    expect(lattice.points).toHaveLength(12)

    // Identity comparison, so this fails if the stride arithmetic is wrong even when the coordinates happen to look plausible.
    expect(vertexAt(lattice, 1, 0)).toBe(lattice.points[1])
    expect(vertexAt(lattice, 2, 0)).toBe(lattice.points[2])
    expect(vertexAt(lattice, 1, 1)).toBe(lattice.points[5])
    expect(vertexAt(lattice, 2, 1)).toBe(lattice.points[6])
    expect(vertexAt(lattice, 3, 2)).toBe(lattice.points[11])
  })

  it('gives the four corners of the piece at column 1, row 0', () => {
    const lattice = buildLattice(worked)

    expect(vertexAt(lattice, 1, 0)).toEqual({ x: 100, y: 0 })
    expect(vertexAt(lattice, 2, 0)).toEqual({ x: 200, y: 0 })
    expect(vertexAt(lattice, 1, 1)).toEqual({ x: 100, y: 100 })
    expect(vertexAt(lattice, 2, 1)).toEqual({ x: 200, y: 100 })
  })

  it('refuses out of range access', () => {
    const lattice = buildLattice(worked)

    expect(() => vertexAt(lattice, 4, 0)).toThrow()
    expect(() => vertexAt(lattice, 0, 3)).toThrow()

    // The dangerous one. A negative column computes a valid index belonging to the previous row, so without a bounds check it would quietly return the wrong vertex.
    expect(() => vertexAt(lattice, -1, 1)).toThrow()
  })
})

describe('gridOptions', () => {
  it('describes bands that make sense on their own', () => {
    for (const band of PIECE_COUNT_BANDS) {
      expect(band.minPieces, band.name).toBeLessThan(band.maxPieces)
      expect(band.targetPieces, band.name).toBeGreaterThanOrEqual(band.minPieces)
      expect(band.targetPieces, band.name).toBeLessThanOrEqual(band.maxPieces)
    }

    // Non overlapping and ascending, so a player reading the dropdown top to bottom sees piece counts only go up.
    for (let i = 1; i < PIECE_COUNT_BANDS.length; i++) {
      expect(PIECE_COUNT_BANDS[i]!.minPieces).toBeGreaterThan(PIECE_COUNT_BANDS[i - 1]!.maxPieces)
    }
  })

  it('offers one grid per band, in ascending order', () => {
    for (const aspect of ASPECTS) {
      const options = gridOptions(aspect.w, aspect.h)
      expect(options, aspect.name).toHaveLength(PIECE_COUNT_BANDS.length)

      for (let i = 1; i < options.length; i++) {
        expect(options[i]!.grid.pieceCount, `${aspect.name} band ${i}`).toBeGreaterThan(options[i - 1]!.grid.pieceCount)
      }
    }
  })

  // This is the whole promise. The dropdown says "Medium, 500 to 700" and the player must never be handed 480.
  // chooseGrid rounds two square roots to integers, which moves the count by a few percent, and the narrowest band is 200 wide.
  // Proving it on three example images would be luck. Sweeping the aspect ratio is the actual gate.
  it('never escapes its own band, at any aspect ratio', () => {
    let inspected = 0

    for (let aspect = 0.1; aspect <= 10; aspect += 0.05) {
      const width = Math.round(1000 * aspect)
      const height = 1000

      for (const { band, grid } of gridOptions(width, height)) {
        const where = `${band.name} at aspect ${aspect.toFixed(2)} gave ${grid.pieceCount}`
        expect(grid.pieceCount, where).toBeGreaterThanOrEqual(band.minPieces)
        expect(grid.pieceCount, where).toBeLessThanOrEqual(band.maxPieces)
        inspected++
      }
    }

    // Proving the sweep ran. A loop that inspected nothing passes every assertion inside it.
    expect(inspected).toBeGreaterThan(500)
  })

  it('keeps cells near square in every band', () => {
    for (const aspect of ASPECTS) {
      for (const { band, grid } of gridOptions(aspect.w, aspect.h)) {
        const cellAspect = grid.cellWidth / grid.cellHeight
        expect(Math.abs(cellAspect - 1), `${band.name} on ${aspect.name}`).toBeLessThan(0.12)
      }
    }
  })
})

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

  it('walks the four corners clockwise from the top left', () => {
    const piece = cellPath(buildLattice(worked), 1, 0)

    expect(piece.path).toEqual([
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 100, y: 100 },
    ])
  })

  // The piece grid is cols wide. The lattice is cols + 1 wide. Using the lattice stride here numbers piece (2, 1) as 6 instead of 5, which collides with nothing and so would never crash.
  it('numbers pieces on the piece grid, not the lattice stride', () => {
    const lattice = buildLattice(worked)

    expect(cellPath(lattice, 0, 0).id).toBe(0)
    expect(cellPath(lattice, 2, 0).id).toBe(2)
    expect(cellPath(lattice, 0, 1).id).toBe(3)
    expect(cellPath(lattice, 2, 1).id).toBe(5)
  })

  it('wraps the path exactly in the bounding box', () => {
    const piece = cellPath(buildLattice(worked), 2, 1)

    expect(piece.bbox).toEqual({ x: 200, y: 100, width: 100, height: 100 })

    for (const point of piece.path) {
      expect(point.x).toBeGreaterThanOrEqual(piece.bbox.x)
      expect(point.x).toBeLessThanOrEqual(piece.bbox.x + piece.bbox.width)
      expect(point.y).toBeGreaterThanOrEqual(piece.bbox.y)
      expect(point.y).toBeLessThanOrEqual(piece.bbox.y + piece.bbox.height)
    }
  })

  // solved is the grid origin, which is the top left lattice vertex, not the top left of the bbox.
  // They coincide while edges are straight. A tab hanging off the top or left will separate them at 2.7, and this test is what will say so.
  it('puts solved on the top left lattice vertex', () => {
    const lattice = buildLattice(worked)

    for (let row = 0; row < worked.rows; row++) {
      for (let col = 0; col < worked.cols; col++) {
        expect(cellPath(lattice, col, row).solved).toEqual(vertexAt(lattice, col, row))
      }
    }
  })

  // The real gate. If the areas add up to the image, no pixel is in two pieces and none is in zero.
  // This is the property a jigsaw actually needs and it is much stronger than eyeballing the picture.
  it('covers the image exactly, with no gaps and no overlaps', () => {
    let inspected = 0

    for (const aspect of ASPECTS) {
      for (const { band, grid } of gridOptions(aspect.w, aspect.h)) {
        const pieces = cellPaths(buildLattice(grid))
        const total = pieces.reduce((sum, piece) => sum + polygonArea(piece.path), 0)
        const imageArea = grid.imageWidth * grid.imageHeight

        expect(Math.abs(total - imageArea) / imageArea, `${band.name} on ${aspect.name}`).toBeLessThan(1e-12)
        inspected += pieces.length
      }
    }

    expect(inspected).toBeGreaterThan(3000)
  })

  // Straight edges make this trivially true. It stops being trivial at 2.7, when the shared edge has to be generated once and consumed by both sides mirrored, so the test is worth having in place before then.
  it('agrees with its neighbours on the corners they share', () => {
    const grid = chooseGrid(600, 1600, 1200)
    const lattice = buildLattice(grid)

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const piece = cellPath(lattice, col, row)

        if (col + 1 < grid.cols) {
          const right = cellPath(lattice, col + 1, row)
          expect(piece.path[1], `${col},${row} top right`).toEqual(right.path[0])
          expect(piece.path[2], `${col},${row} bottom right`).toEqual(right.path[3])
        }

        if (row + 1 < grid.rows) {
          const below = cellPath(lattice, col, row + 1)
          expect(piece.path[3], `${col},${row} bottom left`).toEqual(below.path[0])
          expect(piece.path[2], `${col},${row} bottom right`).toEqual(below.path[1])
        }
      }
    }
  })

  it('refuses cells outside the puzzle', () => {
    const lattice = buildLattice(worked)

    // The lattice has a vertex at column 3, but the puzzle has no piece there. Off by one between the two grids is the mistake this guards.
    expect(() => cellPath(lattice, 3, 0)).toThrow()
    expect(() => cellPath(lattice, 0, 2)).toThrow()
    expect(() => cellPath(lattice, -1, 0)).toThrow()
  })
})

describe('cellPaths', () => {
  it('returns every piece exactly once, in id order', () => {
    const grid = chooseGrid(600, 1600, 1200)
    const pieces = cellPaths(buildLattice(grid))

    expect(pieces).toHaveLength(grid.pieceCount)
    pieces.forEach((piece, index) => {
      expect(piece.id).toBe(index)
    })

    expect(new Set(pieces.map((piece) => `${piece.col},${piece.row}`)).size).toBe(grid.pieceCount)
  })
})
