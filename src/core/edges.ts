// The cut lines between pieces, each one carrying a tab.
//
// The rule this module exists to enforce: an edge is generated once and consumed by both pieces that share it.
// Piece A walks it forwards as its bottom edge, piece B walks the same stored points backwards as its top edge.
// Nothing is mirrored. The tab sits at a fixed place in space, so whichever piece is on the bulge side gets a knob and the other gets a socket, and neither piece does anything special to make that happen.
// Generating the edge twice, once per piece, would put them a floating point hair apart and the puzzle would not fit together.

import { deriveSeed, makeRng } from './rng'
import { vertexAt, type Lattice, type Point } from './lattice'

// A point in an edge's own frame. t runs 0 to 1 from the start vertex to the end vertex, n is how far off the line, both as fractions of the edge's length.
// Working in fractions is what makes a tab scale with its edge, so a puzzle with slightly different cell sizes still looks uniform.
interface Local {
  t: number
  n: number
}

interface Cubic {
  c1: Local
  c2: Local
  to: Local
}

const TAB_START: Local = { t: 0, n: 0 }

// Five cubics: flat, neck out, head, neck back, flat.
//
// The only property that actually matters is that the head is wider than the neck. If it is not, the piece slides straight out and this is not a jigsaw.
// The head's control points sit at t 0.33 and 0.67, well outside its endpoints at 0.45 and 0.55, which is what makes the curve bulge back over the neck.
// Concretely the head spans about 0.424 to 0.576 while the neck is 0.45 to 0.55, and its peak reaches n 0.27. The test states that as a non monotonic t, which is the same fact said in a way a computer can check.
// These numbers are a starting point tuned by eye at 2.9, not a claim of correctness.
const TAB_PROFILE: readonly Cubic[] = [
  { c1: { t: 0.15, n: 0 }, c2: { t: 0.3, n: 0 }, to: { t: 0.4, n: 0 } },
  { c1: { t: 0.44, n: 0 }, c2: { t: 0.42, n: 0.06 }, to: { t: 0.45, n: 0.12 } },
  { c1: { t: 0.33, n: 0.32 }, c2: { t: 0.67, n: 0.32 }, to: { t: 0.55, n: 0.12 } },
  { c1: { t: 0.58, n: 0.06 }, c2: { t: 0.56, n: 0 }, to: { t: 0.6, n: 0 } },
  { c1: { t: 0.7, n: 0 }, c2: { t: 0.85, n: 0 }, to: { t: 1, n: 0 } },
]

export interface TabOptions {
  // Multiplier on how far the tab reaches off the line. Zero gives straight edges, which is what 2.5 produced.
  size?: number
  // How much the size and the centre position vary per edge. Zero makes every tab identical.
  variance?: number
  // Points emitted per cubic. Five cubics per edge, so 8 gives 41 points.
  samples?: number
}

const DEFAULT_SIZE = 1
const DEFAULT_VARIANCE = 0.15
const DEFAULT_SAMPLES = 8

const MAX_VARIANCE = 0.5

export interface EdgeSet {
  cols: number
  rows: number
  // Runs left to right, from vertex (col, row) to (col + 1, row). Index is row * cols + col, for col in 0 to cols - 1 and row in 0 to rows.
  horizontal: Point[][]
  // Runs top to bottom, from vertex (col, row) to (col, row + 1). Index is row * (cols + 1) + col, for col in 0 to cols and row in 0 to rows - 1.
  vertical: Point[][]
}

// Read one edge. Same reason as vertexAt: the index arithmetic lives in one place and out of range access fails loudly instead of returning a neighbour's edge.
export function horizontalEdge(edges: EdgeSet, col: number, row: number): Point[] {
  if (col < 0 || col >= edges.cols || row < 0 || row > edges.rows) {
    throw new Error(`horizontal edge (${col}, ${row}) is outside a ${edges.cols} by ${edges.rows} puzzle`)
  }
  return edges.horizontal[row * edges.cols + col]!
}

export function verticalEdge(edges: EdgeSet, col: number, row: number): Point[] {
  if (col < 0 || col > edges.cols || row < 0 || row >= edges.rows) {
    throw new Error(`vertical edge (${col}, ${row}) is outside a ${edges.cols} by ${edges.rows} puzzle`)
  }
  return edges.vertical[row * (edges.cols + 1) + col]!
}

// Build every cut line for a lattice.
//
// Draw order is horizontal edges row major, then vertical edges row major, and border edges take no draws because they carry no tab.
// That order is fixed on purpose: the generator is a sequence, so reordering this loop would change every tab. The grid dimensions are already part of the build signature, so a different grid producing different tabs is expected.
export function buildEdges(lattice: Lattice, masterSeed: number, options: TabOptions = {}): EdgeSet {
  const size = options.size ?? DEFAULT_SIZE
  if (!(size >= 0)) {
    throw new Error(`tab size must be zero or more, got ${size}`)
  }

  const variance = options.variance ?? DEFAULT_VARIANCE
  if (!(variance >= 0 && variance <= MAX_VARIANCE)) {
    throw new Error(`tab variance must be between 0 and ${MAX_VARIANCE}, got ${variance}`)
  }

  const samples = options.samples ?? DEFAULT_SAMPLES
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error(`tab samples must be a whole number of at least 1, got ${samples}`)
  }

  const rng = makeRng(deriveSeed(masterSeed, 'tabs'), 'edges')

  const horizontal: Point[][] = new Array<Point[]>(lattice.cols * (lattice.rows + 1))
  for (let row = 0; row <= lattice.rows; row++) {
    for (let col = 0; col < lattice.cols; col++) {
      const from = vertexAt(lattice, col, row)
      const to = vertexAt(lattice, col + 1, row)
      const onBorder = row === 0 || row === lattice.rows

      horizontal[row * lattice.cols + col] = onBorder
        ? [{ x: from.x, y: from.y }, { x: to.x, y: to.y }]
        : tabbedEdge(from, to, rng.sign(), size * (1 + rng.range(-variance, variance)), rng.range(-variance, variance) * 0.2, samples)
    }
  }

  const vertical: Point[][] = new Array<Point[]>((lattice.cols + 1) * lattice.rows)
  for (let row = 0; row < lattice.rows; row++) {
    for (let col = 0; col <= lattice.cols; col++) {
      const from = vertexAt(lattice, col, row)
      const to = vertexAt(lattice, col, row + 1)
      const onBorder = col === 0 || col === lattice.cols

      vertical[row * (lattice.cols + 1) + col] = onBorder
        ? [{ x: from.x, y: from.y }, { x: to.x, y: to.y }]
        : tabbedEdge(from, to, rng.sign(), size * (1 + rng.range(-variance, variance)), rng.range(-variance, variance) * 0.2, samples)
    }
  }

  return { cols: lattice.cols, rows: lattice.rows, horizontal, vertical }
}

// One cut line, flattened to a polyline.
//
// Beziers are flattened here rather than published, so PiecePath stays a plain point list and every consumer downstream, the lab, the area test and the bake, keeps working unchanged.
// If the bake ever wants true curves they can be emitted behind the PieceGeometryProvider interface at 2.8 instead.
function tabbedEdge(from: Point, to: Point, side: number, size: number, shift: number, samples: number): Point[] {
  // A tab of zero height is a straight line, and sampling a straight line 41 times is pure waste.
  // This is also what makes size zero reproduce the straight edged cut of 2.5 exactly rather than merely geometrically.
  if (size === 0) {
    return [{ x: from.x, y: from.y }, { x: to.x, y: to.y }]
  }

  const alongX = to.x - from.x
  const alongY = to.y - from.y
  const length = Math.hypot(alongX, alongY)

  // The edge's own two axes. across is along rotated a quarter turn, and which of the two perpendicular directions it points does not matter because side flips it anyway.
  const alongUnitX = alongX / length
  const alongUnitY = alongY / length
  const acrossUnitX = -alongUnitY
  const acrossUnitY = alongUnitX

  const place = (local: Local): Point => {
    // Nudging the tab along the edge without moving its ends. 4t(1-t) is a bump that is zero at both ends and one in the middle, so the shift fades out exactly where the edge has to meet its vertex.
    const t = local.t + shift * 4 * local.t * (1 - local.t)
    const n = local.n * size * side

    return {
      x: from.x + alongUnitX * (t * length) + acrossUnitX * (n * length),
      y: from.y + alongUnitY * (t * length) + acrossUnitY * (n * length),
    }
  }

  const path: Point[] = [place(TAB_START)]

  let start = TAB_START
  for (const segment of TAB_PROFILE) {
    for (let step = 1; step <= samples; step++) {
      path.push(place(cubicAt(start, segment.c1, segment.c2, segment.to, step / samples)))
    }
    start = segment.to
  }

  return path
}

// Standard cubic Bezier. The four weights are the terms of (u + s) cubed with u = 1 - s, so they always sum to one and the curve stays inside the hull of its four points.
function cubicAt(p0: Local, c1: Local, c2: Local, p1: Local, s: number): Local {
  const u = 1 - s
  const w0 = u * u * u
  const w1 = 3 * u * u * s
  const w2 = 3 * u * s * s
  const w3 = s * s * s

  return {
    t: w0 * p0.t + w1 * c1.t + w2 * c2.t + w3 * p1.t,
    n: w0 * p0.n + w1 * c1.n + w2 * c2.n + w3 * p1.n,
  }
}
