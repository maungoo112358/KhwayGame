// Turning PuzzleState into plain, JSON-safe data and back. Deliberately separate from storage.ts:
// this file is pure, testable in vitest, no IndexedDB, no Blob. What actually goes on disk (or in
// IndexedDB) is storage.ts's job.
//
// heldBy is deliberately not saved. It is per-session input book keeping, not puzzle progress, same
// reasoning as CommandContext.actorAnchor in commands.ts: nobody is still holding a piece across a
// reload, and if they were, that is not information a save file should pretend to remember.

import type { PuzzleBuild } from '../core'
import { createPuzzleState, type PuzzleState } from './puzzle'

export interface SavedPuzzleState {
  x: number[]
  y: number[]
  parent: number[]
}

export function serializePuzzleState(state: PuzzleState): SavedPuzzleState {
  return {
    x: Array.from(state.x),
    y: Array.from(state.y),
    parent: Array.from(state.parent),
  }
}

// Rebuilds a PuzzleState from a freshly baked PuzzleBuild plus a previously saved position and cluster
// snapshot. The build is not saved itself, D11's call: re-baking from the working image, seed and grid
// costs 1 to 3 seconds and storing two 4096 square atlas sheets would cost 10 to 30MB per save and lock
// in the piece size forever. Throws rather than silently truncating if the counts do not match, which
// would mean the save was made against a different build than the one just baked.
export function restorePuzzleState(build: PuzzleBuild, saved: SavedPuzzleState): PuzzleState {
  const state = createPuzzleState(build)

  if (saved.x.length !== state.pieceCount || saved.y.length !== state.pieceCount || saved.parent.length !== state.pieceCount) {
    throw new Error(`save has ${saved.x.length} pieces, this build has ${state.pieceCount}`)
  }

  for (let id = 0; id < state.pieceCount; id++) {
    state.x[id] = saved.x[id]!
    state.y[id] = saved.y[id]!
    state.parent[id] = saved.parent[id]!
  }

  return state
}
