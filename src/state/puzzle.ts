// PuzzleState: where every piece currently is and which cluster it belongs to. Structure of arrays
// typed arrays rather than one object per piece, per docs/architecture.md's low level techniques table.
// Pure data, no Pixi, no DOM. render/ subscribes and reflects, it never pokes these arrays directly,
// only through the commands in commands.ts.

import type { AssembledPiece, PuzzleBuild, Rng } from '../core'

export interface PuzzleState {
  readonly pieceCount: number
  // Current position per piece, index = piece id. Starts at each piece's solved position.
  readonly x: Float32Array
  readonly y: Float32Array
  // Union find parent pointer per piece, index = piece id. parent[id] === id means id is its own root.
  readonly parent: Int32Array
  // Actor id currently holding this piece's whole cluster, or -1. Not "the dragged piece", "pieces held
  // by actor X", so co-op never has to assume a single player. See docs/architecture.md's forward
  // compatibility notes.
  readonly heldBy: Int32Array
  // Read only reference into the build this state was created from. solved, neighbors, anchor and frame
  // all live here and never change once the puzzle is baked, so there is nothing to gain by copying them.
  readonly pieces: readonly AssembledPiece[]
}

export function createPuzzleState(build: PuzzleBuild): PuzzleState {
  const pieceCount = build.pieces.length
  const x = new Float32Array(pieceCount)
  const y = new Float32Array(pieceCount)
  const parent = new Int32Array(pieceCount)
  const heldBy = new Int32Array(pieceCount).fill(-1)

  for (const piece of build.pieces) {
    x[piece.id] = piece.solved.x
    y[piece.id] = piece.solved.y
    parent[piece.id] = piece.id
  }

  return { pieceCount, x, y, parent, heldBy, pieces: build.pieces }
}

// Scatters every piece to a random position within bounds, in place. Kept separate from creation because
// a resumed save skips this entirely, positions come from the save instead.
export function scatterPieces(state: PuzzleState, bounds: { w: number; h: number }, rng: Rng): void {
  for (let id = 0; id < state.pieceCount; id++) {
    const piece = state.pieces[id]!
    state.x[id] = rng.range(0, Math.max(0, bounds.w - piece.frame.width))
    state.y[id] = rng.range(0, Math.max(0, bounds.h - piece.frame.height))
  }
}

// True once every piece has merged into one cluster, whatever id happens to be its root. The win
// condition: nothing here cares which piece that is, only that there is exactly one.
export function isSolved(state: PuzzleState, clusters: { find(id: number): number }): boolean {
  if (state.pieceCount === 0) return false
  const root = clusters.find(0)
  for (let id = 1; id < state.pieceCount; id++) {
    if (clusters.find(id) !== root) return false
  }
  return true
}
