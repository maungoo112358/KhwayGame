// Displacing lattice vertices so the cut looks hand made instead of machine ruled.
//
// Topology does not change here. Cell (c, r) keeps the same four vertices and the same neighbours, only their positions move, so nothing downstream needs to know this step happened.
// See D18 for why this uses smooth noise rather than the PRNG, and for why the clamp rather than the noise is what makes the result safe.

import { deriveSeed } from './rng'
import { valueNoise2d } from './noise'
import { vertexAt, type Grid, type Lattice, type Point } from './lattice'

export interface WarpOptions {
  // Fraction of the smaller cell dimension. Zero is a legal request meaning no warp at all, which is what the lab's slider sits on at its low end.
  amplitude?: number
  // Cells per noise cell. Lower approaches white noise, higher gives longer lazier bows.
  scale?: number
}

const DEFAULT_AMPLITUDE = 0.12
const DEFAULT_SCALE = 3

// Half a cell is where two neighbouring vertices would meet, so anything below it cannot cross. 0.4 keeps a visible margin below that.
// This is a hard ceiling rather than a silent clamp, because a clamp turns a caller's bug into a puzzle that looks slightly wrong for reasons nobody can trace.
export const MAX_AMPLITUDE = 0.4

// Returns a new lattice. The input is not touched, so the lab can re-warp the same grid at a different amplitude without rebuilding it.
export function warpLattice(lattice: Lattice, grid: Grid, masterSeed: number, options: WarpOptions = {}): Lattice {
  if (lattice.cols !== grid.cols || lattice.rows !== grid.rows) {
    throw new Error(`lattice is ${lattice.cols} by ${lattice.rows} but grid is ${grid.cols} by ${grid.rows}`)
  }

  const amplitude = options.amplitude ?? DEFAULT_AMPLITUDE
  if (!(amplitude >= 0 && amplitude <= MAX_AMPLITUDE)) {
    throw new Error(`warp amplitude must be between 0 and ${MAX_AMPLITUDE}, got ${amplitude}`)
  }

  const scale = options.scale ?? DEFAULT_SCALE
  if (!(scale > 0)) {
    throw new Error(`warp scale must be positive, got ${scale}`)
  }

  // Two independent fields. One field used for both axes would move every vertex along the same diagonal, which shears the sheet instead of flexing it.
  // Separate named streams also mean a later change to one cannot disturb the other, which is the whole reason deriveSeed exists.
  const seedX = deriveSeed(masterSeed, 'warp-x')
  const seedY = deriveSeed(masterSeed, 'warp-y')

  // The smaller cell dimension governs both axes. Bounding x by cellWidth and y by cellHeight separately would allow more movement on the wider axis, for no visible gain and a second proof to carry.
  const reach = amplitude * Math.min(grid.cellWidth, grid.cellHeight)

  const points: Point[] = new Array<Point>(lattice.points.length)

  for (let row = 0; row <= lattice.rows; row++) {
    for (let col = 0; col <= lattice.cols; col++) {
      const source = vertexAt(lattice, col, row)

      // Dividing by scale is the entire reason this comes out smooth. Sampling at (col, row) would land on whole numbers every time, the interpolation would never run, and the result would be white noise with extra steps.
      const noiseX = col / scale
      const noiseY = row / scale

      let dx = valueNoise2d(noiseX, noiseY, seedX) * reach
      let dy = valueNoise2d(noiseX, noiseY, seedY) * reach

      // Pin the border so the finished puzzle is still a rectangle.
      // A border vertex still slides along its own edge, which is what makes edge pieces vary in width the way real ones do.
      // The four corners need no special case: both conditions fire on them, so both components end up zero.
      if (col === 0 || col === lattice.cols) dx = 0
      if (row === 0 || row === lattice.rows) dy = 0

      points[row * lattice.stride + col] = { x: source.x + dx, y: source.y + dy }
    }
  }

  return { cols: lattice.cols, rows: lattice.rows, stride: lattice.stride, points }
}
