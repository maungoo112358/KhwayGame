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

// Two octaves rather than one.
//
// A single octave of value noise bows the whole sheet in coherent waves, which reads as a curtain rather than as a hand cut. That was visible in the lab and is what these three constants fix.
// The detail octave runs at three times the frequency and a third of the amplitude, so it breaks the long waves up with local wobble without changing the overall shape.
//
// Dividing by the total gain keeps the result inside [-1, 1], so the crossing proof is untouched: displacement is still at most the reach, and the reach is still under half a cell.
// What does change is how fast the field can vary. The base octave's slope is bounded by 3, the detail octave's by 3 times its lacunarity times its gain, which is also 3. Normalised, the combined bound is 4.5 rather than 3, and warp.test.ts asserts that figure.
const DETAIL_LACUNARITY = 3
const DETAIL_GAIN = 1 / 3
const OCTAVE_NORMALISE = 1 / (1 + DETAIL_GAIN)

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

  // The detail octaves get their own streams rather than reusing the base seed at a higher frequency.
  // Sampling one field at 3x lands back on the same stored values wherever the coordinate is a whole number, which would correlate the two octaves exactly where the base octave is already at a lattice point.
  const detailSeedX = deriveSeed(masterSeed, 'warp-x-detail')
  const detailSeedY = deriveSeed(masterSeed, 'warp-y-detail')

  // The smaller cell dimension governs both axes. Bounding x by cellWidth and y by cellHeight separately would allow more movement on the wider axis, for no visible gain and a second proof to carry.
  const reach = amplitude * Math.min(grid.cellWidth, grid.cellHeight)

  const points: Point[] = new Array<Point>(lattice.points.length)

  for (let row = 0; row <= lattice.rows; row++) {
    for (let col = 0; col <= lattice.cols; col++) {
      const source = vertexAt(lattice, col, row)

      // Dividing by scale is the entire reason this comes out smooth. Sampling at (col, row) would land on whole numbers every time, the interpolation would never run, and the result would be white noise with extra steps.
      const noiseX = col / scale
      const noiseY = row / scale

      let dx = fractalNoise(noiseX, noiseY, seedX, detailSeedX) * reach
      let dy = fractalNoise(noiseX, noiseY, seedY, detailSeedY) * reach

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

// A gentle bow plus local wobble, in [-1, 1]. See the constants above for why it is normalised and what it costs in slope.
function fractalNoise(x: number, y: number, baseSeed: number, detailSeed: number): number {
  const base = valueNoise2d(x, y, baseSeed)
  const detail = valueNoise2d(x * DETAIL_LACUNARITY, y * DETAIL_LACUNARITY, detailSeed)

  return (base + detail * DETAIL_GAIN) * OCTAVE_NORMALISE
}
