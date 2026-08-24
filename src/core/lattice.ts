// The grid a puzzle is cut on, before any warping.
//
// Vocabulary used throughout the geometry code:
//   lattice   the whole grid of corner points
//   vertex    one corner point
//   cell      one quadrilateral between four vertices, which becomes one piece
//   edge      the connection between two neighbouring vertices, which becomes one cut line
//
// For cols by rows pieces the lattice holds (cols + 1) by (rows + 1) vertices, because of the extra row and column of outer corners.

export interface Point {
  x: number
  y: number
}

export interface Grid {
  cols: number
  rows: number
  pieceCount: number // The real number of pieces, which is rarely the number that was asked for. See chooseGrid.
  imageWidth: number
  imageHeight: number
  cellWidth: number
  cellHeight: number
}

export interface Lattice {
  cols: number
  rows: number
  // Vertices per row, which is cols + 1. This is the stride for indexing into points, and using cols here by mistake produces a sheared puzzle rather than a crash.
  stride: number
  points: Point[]// Flat, row major, length (cols + 1) * (rows + 1). Index with vertexAt rather than by hand.
}

// Pick cols and rows for a requested piece count, favouring square cells.
// Writing a for the image aspect ratio W/H, square cells mean W/cols = H/rows, so cols = a * rows.
// Combined with cols * rows = N that gives rows = sqrt(N/a) and cols = sqrt(N*a).
// Portrait images need no special case: a below 1 simply yields more rows than columns.
//
// Those are rarely whole numbers, and rounding them trades piece count against squareness.
// We just round. Real 1000 piece puzzles are not 1000 pieces either, Ravensburger's are commonly 38 by 27 which is 1026, because manufacturers also pick the grid that keeps pieces square and let the count land where it lands.
// The true count comes back in pieceCount and is what the UI should show.
export function chooseGrid(targetPieces: number, imageWidth: number, imageHeight: number): Grid {
  if (!(targetPieces > 0) || !(imageWidth > 0) || !(imageHeight > 0)) {
    throw new Error(`chooseGrid needs positive values, got ${targetPieces} pieces at ${imageWidth} by ${imageHeight}`)
  }

  const aspect = imageWidth / imageHeight

  // Two pieces is the smallest grid that still has an internal edge to cut.
  const cols = Math.max(2, Math.round(Math.sqrt(targetPieces * aspect)))
  const rows = Math.max(2, Math.round(Math.sqrt(targetPieces / aspect)))

  return {
    cols,
    rows,
    pieceCount: cols * rows,
    imageWidth,
    imageHeight,
    cellWidth: imageWidth / cols,
    cellHeight: imageHeight / rows,
  }
}

// The three sizes a player may pick from.
//
// Asking the player for a number is a lie, because chooseGrid rounds and hands back something else.
// Offering bands instead means the promise (a puzzle of roughly this size) is kept exactly, and the true count is shown rather than corrected afterwards.
// Small, medium and large describe the puzzle, not the pieces, so large means the most pieces and the smallest ones.
export interface PieceCountBand {
  id: 'small' | 'medium' | 'large'
  name: string
  minPieces: number
  maxPieces: number
  // What chooseGrid aims at. The band midpoint, kept explicit so it can be tuned without moving the band edges.
  targetPieces: number
}

export interface GridOption {
  band: PieceCountBand
  grid: Grid
}

export const PIECE_COUNT_BANDS: readonly PieceCountBand[] = [
  { id: 'small', name: 'Small', minPieces: 100, maxPieces: 400, targetPieces: 250 },
  { id: 'medium', name: 'Medium', minPieces: 500, maxPieces: 700, targetPieces: 600 },
  { id: 'large', name: 'Large', minPieces: 800, maxPieces: 1100, targetPieces: 950 },
]

// What this particular image can actually be cut into, one grid per band.
//
// No new grid picking algorithm, deliberately. A band is a target with a generous tolerance, so this is chooseGrid at the midpoint and nothing more.
// Rounding moves the count by a few percent at most, and the narrowest band is 200 wide, so the result cannot escape its own band. lattice.test.ts proves that across a sweep of aspect ratios.
export function gridOptions(imageWidth: number, imageHeight: number): GridOption[] {
  return PIECE_COUNT_BANDS.map((band) => ({
    band,
    grid: chooseGrid(band.targetPieces, imageWidth, imageHeight),
  }))
}

// Build the unwarped lattice, in image pixel coordinates.
// Vertex (0, 0) sits at the top left of the image and vertex (cols, rows) sits exactly on the bottom right corner.
export function buildLattice(grid: Grid): Lattice {
  const stride = grid.cols + 1
  const points: Point[] = new Array<Point>(stride * (grid.rows + 1))

  for (let row = 0; row <= grid.rows; row++) {
    for (let col = 0; col <= grid.cols; col++) {
      points[row * stride + col] = {
        // Fraction first, then scale. At the far edge col/cols is exactly 1, so the last vertex lands exactly on imageWidth.
        // Stepping by cellWidth instead would accumulate floating point error and miss the corner by a hair.
        x: (col / grid.cols) * grid.imageWidth,
        y: (row / grid.rows) * grid.imageHeight,
      }
    }
  }

  return { cols: grid.cols, rows: grid.rows, stride, points }
}

// Read one vertex. Use this rather than indexing points directly.
//
// It keeps the row * stride + col arithmetic in one place, and it catches out of range access.
// A negative column is the dangerous case: col -1 on row 1 computes a valid index belonging to row 0, so it would silently return the wrong vertex rather than fail.
export function vertexAt(lattice: Lattice, col: number, row: number): Point {
  if (col < 0 || col > lattice.cols || row < 0 || row > lattice.rows) {
    throw new Error(`vertex (${col}, ${row}) is outside a ${lattice.cols} by ${lattice.rows} lattice`)
  }

  const point = lattice.points[row * lattice.stride + col]
  if (point === undefined) {
    throw new Error(`lattice is missing vertex (${col}, ${row})`)
  }

  return point
}
