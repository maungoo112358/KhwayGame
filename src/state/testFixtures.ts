// Synthetic PuzzleBuild for state/'s own tests. No bake, no canvas: a regular unwarped grid is all these
// tests need, since they are about state mutation and adjacency, not geometry or image content. Not
// exported from index.ts, this is test-only.

import type { AssembledPiece, PuzzleBuild } from '../core'

// Every bit set, so pointInPieceMask reads true anywhere inside the piece's bbox. Real pieces have real
// silhouettes; these tests only need a hit test that behaves like a solid square.
function solidAlphaMask(width: number, height: number): AssembledPiece['alphaMask'] {
  const w = Math.max(1, Math.ceil(width * 0.5))
  const h = Math.max(1, Math.ceil(height * 0.5))
  const bits = new Uint8Array(Math.ceil((w * h) / 8)).fill(0xff)
  return { bits, w, h }
}

// cols by rows pieces, cellSize apart, straight grid, no tabs. Real neighbour and edge logic, same
// formula as core/geometry.ts's neighborsOf, so trySnap's adjacency walk is exercised honestly.
export function makeTestBuild(cols: number, rows: number, cellSize: number): PuzzleBuild {
  const pieces: AssembledPiece[] = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const id = row * cols + col
      pieces.push({
        id,
        atlas: 0,
        frame: { x: 0, y: 0, width: cellSize, height: cellSize },
        anchor: { x: 0, y: 0 },
        row,
        col,
        solved: { x: col * cellSize, y: row * cellSize },
        neighbors: [
          row > 0 ? id - cols : null,
          col < cols - 1 ? id + 1 : null,
          row < rows - 1 ? id + cols : null,
          col > 0 ? id - 1 : null,
        ],
        isEdge: row === 0 || col === 0 || row === rows - 1 || col === cols - 1,
        dominantColor: 0,
        alphaMask: solidAlphaMask(cellSize, cellSize),
      })
    }
  }

  return {
    atlases: [],
    pieces,
    version: 1,
    signature: 'test-fixture',
    seed: 1,
    grid: { cols, rows },
    working: { w: cols * cellSize, h: rows * cellSize },
  }
}
