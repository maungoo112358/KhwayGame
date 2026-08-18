import { describe, it, expect } from 'vitest'
import { chooseGrid, buildLattice, cellPaths, vertexAt, type Grid, type Point } from './lattice'
import { warpLattice, MAX_AMPLITUDE } from './warp'

const SEED = 20260818

const ASPECTS = [
  { name: '1:1 square', w: 1000, h: 1000 },
  { name: '4:3 landscape', w: 4000, h: 3000 },
  { name: '16:9 wide', w: 1920, h: 1080 },
  { name: '3:1 panorama', w: 6000, h: 2000 },
  { name: '3:4 portrait', w: 3000, h: 4000 },
]

// The three counts the gate names.
const TARGETS = [100, 500, 1000]

// The default, and the largest value the API will accept. Proving the gate at the default alone would leave the ceiling untested while still permitted.
const AMPLITUDES = [0.12, MAX_AMPLITUDE]

// Which way you turned at q, walking p to q to r.
// Its sign is the standard convexity test: turn the same way at all four corners of a quad and it is convex, flip once and the quad has a dent or is a bow tie.
function cross(p: Point, q: Point, r: Point): number {
  return (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x)
}

function warpedGrid(target: number, width: number, height: number, amplitude?: number) {
  const grid = chooseGrid(target, width, height)
  const lattice = warpLattice(buildLattice(grid), grid, SEED, amplitude === undefined ? {} : { amplitude })
  return { grid, lattice }
}

describe('warpLattice', () => {
  it('leaves the lattice it was given untouched', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const original = buildLattice(grid)
    const before = original.points.map((point) => ({ ...point }))

    warpLattice(original, grid, SEED)

    expect(original.points).toEqual(before)
  })

  it('gives the same result every time for a seed, and a different one for another', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const lattice = buildLattice(grid)

    expect(warpLattice(lattice, grid, SEED).points).toEqual(warpLattice(lattice, grid, SEED).points)
    expect(warpLattice(lattice, grid, SEED).points).not.toEqual(warpLattice(lattice, grid, SEED + 1).points)
  })

  // Half the gate. A vertex crossing its neighbour is the failure the clamp exists to prevent, and this states it directly.
  it('never lets a vertex cross a neighbour, at 100, 500 and 1000 pieces', () => {
    let inspected = 0

    for (const aspect of ASPECTS) {
      for (const target of TARGETS) {
        for (const amplitude of AMPLITUDES) {
          const { lattice } = warpedGrid(target, aspect.w, aspect.h, amplitude)
          const where = `${aspect.name} at ${target}, amplitude ${amplitude}`

          for (let row = 0; row <= lattice.rows; row++) {
            for (let col = 1; col <= lattice.cols; col++) {
              expect(vertexAt(lattice, col, row).x, `${where} row ${row}`).toBeGreaterThan(vertexAt(lattice, col - 1, row).x)
              inspected++
            }
          }

          for (let col = 0; col <= lattice.cols; col++) {
            for (let row = 1; row <= lattice.rows; row++) {
              expect(vertexAt(lattice, col, row).y, `${where} col ${col}`).toBeGreaterThan(vertexAt(lattice, col, row - 1).y)
              inspected++
            }
          }
        }
      }
    }

    // Roughly 33000 neighbour comparisons. The bound is a floor, not the exact figure, so adding an aspect ratio does not turn it red.
    expect(inspected).toBeGreaterThan(30000)
  })

  // The other half. Ordering alone cannot rule out a bow tie, so every cell is checked for convexity through the paths 2.5 already builds.
  it('keeps every cell convex, at 100, 500 and 1000 pieces', () => {
    let inspected = 0

    for (const aspect of ASPECTS) {
      for (const target of TARGETS) {
        for (const amplitude of AMPLITUDES) {
          const { lattice } = warpedGrid(target, aspect.w, aspect.h, amplitude)

          for (const piece of cellPaths(lattice)) {
            const path = piece.path
            for (let i = 0; i < path.length; i++) {
              const turn = cross(path[i]!, path[(i + 1) % path.length]!, path[(i + 2) % path.length]!)
              expect(turn, `${aspect.name} at ${target}, amplitude ${amplitude}, piece ${piece.id} corner ${i}`).toBeGreaterThan(0)
            }
            inspected++
          }
        }
      }
    }

    // Roughly 16000 cells, each checked at all four corners.
    expect(inspected).toBeGreaterThan(15000)
  })

  // Without this the puzzle stops being a rectangle. Exact equality, because the border components are zeroed rather than recomputed.
  it('pins the border exactly', () => {
    for (const aspect of ASPECTS) {
      const { grid, lattice } = warpedGrid(500, aspect.w, aspect.h)

      for (let col = 0; col <= lattice.cols; col++) {
        expect(vertexAt(lattice, col, 0).y, `${aspect.name} top`).toBe(0)
        expect(vertexAt(lattice, col, lattice.rows).y, `${aspect.name} bottom`).toBe(grid.imageHeight)
      }

      for (let row = 0; row <= lattice.rows; row++) {
        expect(vertexAt(lattice, 0, row).x, `${aspect.name} left`).toBe(0)
        expect(vertexAt(lattice, lattice.cols, row).x, `${aspect.name} right`).toBe(grid.imageWidth)
      }

      // The corners need no special case in the implementation, both rules fire on them. This is the check that says so.
      expect(vertexAt(lattice, 0, 0)).toEqual({ x: 0, y: 0 })
      expect(vertexAt(lattice, lattice.cols, lattice.rows)).toEqual({ x: grid.imageWidth, y: grid.imageHeight })
    }
  })

  it('moves no vertex further than the amplitude allows', () => {
    const amplitude = 0.12
    let inspected = 0

    for (const aspect of ASPECTS) {
      const grid = chooseGrid(500, aspect.w, aspect.h)
      const before = buildLattice(grid)
      const after = warpLattice(before, grid, SEED, { amplitude })
      const reach = amplitude * Math.min(grid.cellWidth, grid.cellHeight)

      for (let row = 0; row <= before.rows; row++) {
        for (let col = 0; col <= before.cols; col++) {
          const from = vertexAt(before, col, row)
          const to = vertexAt(after, col, row)

          expect(Math.abs(to.x - from.x), `${aspect.name} (${col}, ${row}) x`).toBeLessThanOrEqual(reach)
          expect(Math.abs(to.y - from.y), `${aspect.name} (${col}, ${row}) y`).toBeLessThanOrEqual(reach)
          inspected++
        }
      }
    }

    expect(inspected).toBeGreaterThan(2500)
  })

  // The one that proves the division by scale is still there.
  // Adjacent vertices are 1/scale noise units apart and the field's slope is bounded by 3, so their displacements cannot differ by more than 3/scale of the reach.
  // White noise neighbours could differ by twice the reach, so dropping the division fails this immediately. Interior vertices only, since a pinned border component is zeroed rather than sampled.
  it('moves neighbouring vertices together rather than independently', () => {
    const amplitude = 0.12
    const scale = 3
    let inspected = 0

    for (const aspect of ASPECTS) {
      const grid = chooseGrid(500, aspect.w, aspect.h)
      const before = buildLattice(grid)
      const after = warpLattice(before, grid, SEED, { amplitude, scale })

      const reach = amplitude * Math.min(grid.cellWidth, grid.cellHeight)
      const allowed = (3 / scale) * reach

      const shift = (col: number, row: number): Point => ({
        x: vertexAt(after, col, row).x - vertexAt(before, col, row).x,
        y: vertexAt(after, col, row).y - vertexAt(before, col, row).y,
      })

      for (let row = 1; row < before.rows; row++) {
        for (let col = 1; col < before.cols; col++) {
          const here = shift(col, row)
          const right = shift(col + 1, row)
          const below = shift(col, row + 1)

          if (col + 1 < before.cols) {
            expect(Math.abs(right.x - here.x), `${aspect.name} (${col}, ${row}) x rightwards`).toBeLessThanOrEqual(allowed)
            expect(Math.abs(right.y - here.y), `${aspect.name} (${col}, ${row}) y rightwards`).toBeLessThanOrEqual(allowed)
          }
          if (row + 1 < before.rows) {
            expect(Math.abs(below.x - here.x), `${aspect.name} (${col}, ${row}) x downwards`).toBeLessThanOrEqual(allowed)
            expect(Math.abs(below.y - here.y), `${aspect.name} (${col}, ${row}) y downwards`).toBeLessThanOrEqual(allowed)
          }
          inspected++
        }
      }
    }

    expect(inspected).toBeGreaterThan(2000)
  })

  // One field used for both axes makes dx equal dy at every single vertex, so the sheet slides diagonally instead of flexing, and every other test here still passes.
  // Ordering and convexity cannot see it, which is why this is stated separately.
  it('samples a separate field per axis', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const before = buildLattice(grid)
    const after = warpLattice(before, grid, SEED)

    let identical = 0
    let inspected = 0

    for (let row = 1; row < before.rows; row++) {
      for (let col = 1; col < before.cols; col++) {
        const dx = vertexAt(after, col, row).x - vertexAt(before, col, row).x
        const dy = vertexAt(after, col, row).y - vertexAt(before, col, row).y

        if (dx === dy) identical++
        inspected++
      }
    }

    expect(inspected).toBeGreaterThan(400)
    expect(identical).toBe(0)
  })

  it('treats an amplitude of zero as no warp at all', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const before = buildLattice(grid)

    expect(warpLattice(before, grid, SEED, { amplitude: 0 }).points).toEqual(before.points)
  })

  it('refuses an amplitude outside the safe range rather than clamping it', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const lattice = buildLattice(grid)

    expect(() => warpLattice(lattice, grid, SEED, { amplitude: -0.01 })).toThrow()
    expect(() => warpLattice(lattice, grid, SEED, { amplitude: 0.5 })).toThrow()
    expect(() => warpLattice(lattice, grid, SEED, { amplitude: Number.NaN })).toThrow()

    // The ceiling itself is legal, it is the first value past it that is not.
    expect(() => warpLattice(lattice, grid, SEED, { amplitude: MAX_AMPLITUDE })).not.toThrow()
  })

  it('refuses a scale that would divide by zero or flip the sample', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const lattice = buildLattice(grid)

    expect(() => warpLattice(lattice, grid, SEED, { scale: 0 })).toThrow()
    expect(() => warpLattice(lattice, grid, SEED, { scale: -3 })).toThrow()
  })

  // Amplitude is a fraction of a cell, and the cell size comes from the grid, so a mismatched pair would silently warp by the wrong distance.
  it('refuses a grid that does not match the lattice', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const other: Grid = chooseGrid(900, 1600, 1200)

    expect(() => warpLattice(buildLattice(grid), other, SEED)).toThrow()
  })
})
