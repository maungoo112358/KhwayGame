// Assembling one piece from the four edges around it.
//
// Lives here rather than in lattice.ts because it consumes edges.ts, which already consumes lattice.ts, and a cycle between them would be a layering mistake the arch rules would reject.
//
// A piece is walked clockwise from its top left corner, so two of its edges are traversed forwards and two backwards:
//
//   top     horizontalEdge(col, row)       forwards
//   right   verticalEdge(col + 1, row)     forwards
//   bottom  horizontalEdge(col, row + 1)   reversed
//   left    verticalEdge(col, row)         reversed
//
// The neighbour sharing any of those reads the same stored array in the opposite direction, which is what makes a knob on one piece exactly a socket on the other with no mirroring anywhere.

import { horizontalEdge, verticalEdge, type EdgeSet } from './edges'
import { type Point } from './lattice'

// An axis aligned box in image pixels. Same shape as PieceDef.frame in the PuzzleBuild contract, so it can be handed to the packer later without translation.
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PiecePath {
  // row * cols + col. The piece grid, so the stride here is cols, not the lattice's cols + 1.
  id: number
  col: number
  row: number
  // Closed outline in image pixels, walked clockwise from the top left. The first point is not repeated at the end, closing is the consumer's job.
  path: Point[]
  // Includes tab overhang, so this is larger than the cell wherever a tab sticks out.
  bbox: Bounds
  // Canonical position in puzzle space, the cell's top left lattice vertex, which is where the top edge starts.
  // Deliberately not the bbox corner. A tab hanging off the top or left pushes bbox.x and bbox.y past it, and PieceDef.anchor in the bake is the difference between the two.
  solved: Point
}

export function cellPath(edges: EdgeSet, col: number, row: number): PiecePath {
  if (col < 0 || col >= edges.cols || row < 0 || row >= edges.rows) {
    throw new Error(`cell (${col}, ${row}) is outside a ${edges.cols} by ${edges.rows} puzzle`)
  }

  const top = horizontalEdge(edges, col, row)
  const right = verticalEdge(edges, col + 1, row)
  const bottom = horizontalEdge(edges, col, row + 1)
  const left = verticalEdge(edges, col, row)

  // Copied rather than referenced, so a PiecePath is self contained and nothing downstream can reach back into the edge set through it.
  // Consecutive edges meet at a corner they both contain, so every edge after the first drops its leading point. The last one also drops its trailing point, which is the top left corner the path started on.
  const path: Point[] = []

  for (const point of top) path.push({ x: point.x, y: point.y })
  for (let i = 1; i < right.length; i++) path.push({ x: right[i]!.x, y: right[i]!.y })
  for (let i = bottom.length - 2; i >= 0; i--) path.push({ x: bottom[i]!.x, y: bottom[i]!.y })
  for (let i = left.length - 2; i >= 1; i--) path.push({ x: left[i]!.x, y: left[i]!.y })

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of path) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }

  const origin = top[0]!

  return {
    id: row * edges.cols + col,
    col,
    row,
    path,
    bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    solved: { x: origin.x, y: origin.y },
  }
}

// Every piece, in id order.
export function cellPaths(edges: EdgeSet): PiecePath[] {
  const pieces: PiecePath[] = new Array<PiecePath>(edges.cols * edges.rows)

  for (let row = 0; row < edges.rows; row++) {
    for (let col = 0; col < edges.cols; col++) {
      pieces[row * edges.cols + col] = cellPath(edges, col, row)
    }
  }

  return pieces
}
