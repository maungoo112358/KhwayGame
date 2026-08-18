// The seam between how geometry is produced and everything that consumes it.
//
// Baking, snapping and the save format read PieceGeometry and never learn that there is a lattice, a noise field or a bezier anywhere behind it.
// That is the hedge recorded in D2: if the warped grid ever proves visually inadequate, a Voronoi implementation replaces this one module and nothing downstream changes.
//
// See docs/ARCHITECTURE.md for the PuzzleBuild contract this feeds.

import { buildLattice, type Grid, type Point } from './lattice'
import { warpLattice, type WarpOptions } from './warp'
import { buildEdges, type TabOptions } from './edges'
import { cellPaths, type Bounds } from './pieces'

// Index into the pieces array, in N, E, S, W order, with null where the puzzle ends.
// Same shape and same order as PieceDef.neighbors in the contract, so it can be carried straight through the bake.
export type Neighbors = [number | null, number | null, number | null, number | null]

export interface PieceGeometry {
  id: number
  // Grid coordinates. These are the one part of the published shape that assumes a grid, and they are here because PieceDef promises them.
  // A non grid implementation would have to synthesise them, which is worth knowing before anyone writes one.
  col: number
  row: number
  // Closed outline in image pixels, walked clockwise. The first point is not repeated at the end.
  path: Point[]
  // Includes tab overhang, so it is larger than the piece's nominal cell wherever a tab sticks out.
  bbox: Bounds
  // Canonical position in puzzle space. PieceDef.anchor in the bake is this minus the bbox corner.
  solved: Point
  neighbors: Neighbors
}

export interface PieceGeometryProvider {
  readonly pieceCount: number
  readonly imageWidth: number
  readonly imageHeight: number
  // A method rather than a field, so an implementation is free to build lazily or to cache. This one builds eagerly, because a thousand pieces is not worth the complexity of not doing so.
  pieces(): PieceGeometry[]
}

export interface GeometryOptions {
  // From chooseGrid or gridOptions. Passing the grid rather than a piece count avoids choosing it twice.
  grid: Grid
  // One seed feeds every stream. deriveSeed splits it so the warp and the tabs cannot disturb each other.
  seed: number
  warp?: WarpOptions
  tabs?: TabOptions
}

// The warped grid implementation: lattice, noise warp, tabbed edges, assembled pieces.
// This function is the only place that knows those four steps go together in that order.
export function createWarpedGridGeometry(options: GeometryOptions): PieceGeometryProvider {
  const { grid, seed } = options

  const lattice = warpLattice(buildLattice(grid), grid, seed, options.warp)
  const edges = buildEdges(lattice, seed, options.tabs)

  const pieces: PieceGeometry[] = cellPaths(edges).map((piece) => ({
    id: piece.id,
    col: piece.col,
    row: piece.row,
    path: piece.path,
    bbox: piece.bbox,
    solved: piece.solved,
    neighbors: neighborsOf(piece.col, piece.row, grid.cols, grid.rows),
  }))

  return {
    pieceCount: pieces.length,
    imageWidth: grid.imageWidth,
    imageHeight: grid.imageHeight,
    pieces: () => pieces,
  }
}

// On a grid this is arithmetic. On a Voronoi diagram it would be real adjacency, which is exactly why it belongs to the provider and not to cellPath.
function neighborsOf(col: number, row: number, cols: number, rows: number): Neighbors {
  const id = row * cols + col

  return [
    row > 0 ? id - cols : null,
    col < cols - 1 ? id + 1 : null,
    row < rows - 1 ? id + cols : null,
    col > 0 ? id - 1 : null,
  ]
}
