import { describe, it, expect } from 'vitest'
import { chooseGrid, buildLattice, vertexAt, type Grid } from './lattice'

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
