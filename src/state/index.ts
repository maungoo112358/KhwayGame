// state/ owns where every piece currently is, which cluster it belongs to, and (once picked up) which
// actor holds it. Pure data plus commands that mutate it. No pixi.js, no DOM.
//
// It may import types from core/. It may not import render/, ui/ or lab/.

export { createPuzzleState, scatterPieces, scatterBounds, isSolved } from './puzzle'
export type { PuzzleState, PlacementBounds } from './puzzle'

export { createClusterIndex } from './unionFind'
export type { ClusterIndex } from './unionFind'

export { buildSpatialHash, pickAt, pickAtNaive, pointInPieceMask } from './spatialHash'
export type { SpatialHash } from './spatialHash'

export { applyCommand, createCommandContext } from './commands'
export type { Command, PickUp, Move, Drop, Merge, CommandContext } from './commands'

export { serializePuzzleState, restorePuzzleState } from './save'
export type { SavedPuzzleState } from './save'

export { savePuzzle, loadPuzzle, listPuzzles, getLatestSave, deletePuzzle, imageBitmapToPngBlob } from './storage'
export type { SavedPuzzle } from './storage'
