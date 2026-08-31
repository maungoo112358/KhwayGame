// Per-pixel picking against the real alpha masks, indexed so a query only has to check the handful of
// pieces actually near a point rather than all of them. Moved out of src/stress/ into state/ at Phase 7,
// same reasoning as unionFind.ts, see D23.

import { ALPHA_MASK_SCALE, type AssembledPiece, type Point } from '../core'
import type { PuzzleState } from './puzzle'

// current is where the piece's anchor point actually sits right now. current - anchor is the sprite's
// top left corner, and the same corner pieceAlphaMask built its mask relative to, which is what makes
// this conversion correct.
export function pointInPieceMask(piece: AssembledPiece, current: Point, point: Point): boolean {
  const localX = (point.x - (current.x - piece.anchor.x)) * ALPHA_MASK_SCALE
  const localY = (point.y - (current.y - piece.anchor.y)) * ALPHA_MASK_SCALE
  const mx = Math.floor(localX)
  const my = Math.floor(localY)
  if (mx < 0 || mx >= piece.alphaMask.w || my < 0 || my >= piece.alphaMask.h) return false

  const pixelIndex = my * piece.alphaMask.w + mx
  const byteIndex = pixelIndex >> 3
  const bitIndex = pixelIndex & 7
  return (piece.alphaMask.bits[byteIndex]! & (1 << bitIndex)) !== 0
}

function cellKey(cellX: number, cellY: number): string {
  return `${cellX},${cellY}`
}

export interface SpatialHash {
  cellSize: number
  cells: Map<string, number[]>
}

// Every piece registers into every cell its rendered bbox touches, current position plus frame size, not
// just the cell its corner happens to land in, otherwise a piece straddling a cell boundary would go
// missing from queries against its other cells.
export function buildSpatialHash(state: PuzzleState, cellSize: number): SpatialHash {
  const cells = new Map<string, number[]>()

  for (let id = 0; id < state.pieceCount; id++) {
    const piece = state.pieces[id]!
    const left = state.x[id]! - piece.anchor.x
    const top = state.y[id]! - piece.anchor.y

    const cellX0 = Math.floor(left / cellSize)
    const cellX1 = Math.floor((left + piece.frame.width) / cellSize)
    const cellY0 = Math.floor(top / cellSize)
    const cellY1 = Math.floor((top + piece.frame.height) / cellSize)

    for (let cy = cellY0; cy <= cellY1; cy++) {
      for (let cx = cellX0; cx <= cellX1; cx++) {
        const key = cellKey(cx, cy)
        const bucket = cells.get(key)
        if (bucket) bucket.push(id)
        else cells.set(key, [id])
      }
    }
  }

  return { cellSize, cells }
}

// Same precise pointInPieceMask test as pickAtNaive, only the candidate list differs: whatever is
// registered in the one cell the point falls in, instead of every piece on the board. Later matches
// overwrite earlier ones, so among overlapping pieces the one drawn on top (highest id) wins, matching
// what the player would actually see and expect.
export function pickAt(point: Point, hash: SpatialHash, state: PuzzleState): AssembledPiece | null {
  const cellX = Math.floor(point.x / hash.cellSize)
  const cellY = Math.floor(point.y / hash.cellSize)
  const candidates = hash.cells.get(cellKey(cellX, cellY))
  if (!candidates) return null

  let picked: AssembledPiece | null = null
  for (const id of candidates) {
    const piece = state.pieces[id]!
    const current = { x: state.x[id]!, y: state.y[id]! }
    if (pointInPieceMask(piece, current, point)) picked = piece
  }
  return picked
}

// Deliberately naive: checks every piece, never exits early. Kept as the baseline buildSpatialHash and
// pickAt replace, so there is something real to cross check against, same reasoning as core/kuwahara.ts's
// naive version.
export function pickAtNaive(point: Point, state: PuzzleState): AssembledPiece | null {
  let picked: AssembledPiece | null = null
  for (let id = 0; id < state.pieceCount; id++) {
    const piece = state.pieces[id]!
    const current = { x: state.x[id]!, y: state.y[id]! }
    if (pointInPieceMask(piece, current, point)) picked = piece
  }
  return picked
}
