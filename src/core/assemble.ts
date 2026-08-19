// Turning a whole puzzle's worth of geometry into real atlas sheets: bake every piece, decide where
// each one goes, then actually draw them there. Everything 3.1 through 3.5 built, chained into one run.
//
// Shaped like bake.ts and print.ts: touches OffscreenCanvas and ImageBitmap directly, worker safe by
// construction, not independently vitest tested for that reason, verified by eye and by the clock.
//
// Bakes every piece before packing, using each bitmap's real width and height rather than predicting
// them from the bbox and the rim offset. Predicting would mean duplicating bake.ts's canvas sizing
// formula here, and the two silently drifting apart is exactly the kind of mismatch that would pack a
// piece into a slot too small for it. Correct by construction costs holding every baked bitmap in memory
// briefly before compositing, roughly 100MB at 1000 pieces; worth revisiting under Phase 5 profiling if
// that ever turns out to matter, not before.

import type { PieceGeometry } from './geometry'
import type { Bounds } from './pieces'
import type { Point } from './lattice'
import { bakePiece, type CardboardOptions } from './bake'
import { packAtlas, type AtlasOptions } from './atlas'

export interface AssembleOptions {
  cardboard?: CardboardOptions
  atlas?: AtlasOptions
  // Called every PROGRESS_INTERVAL pieces while baking, the slow part, not once per piece. core/ knows
  // nothing about postMessage, this is how a caller in a Worker reports progress without core depending
  // on one existing.
  onProgress?: (completed: number, total: number) => void
}

const PROGRESS_INTERVAL = 25

export interface AssembledPiece {
  id: number
  atlas: number
  // Where the piece's baked bitmap sits within that atlas sheet.
  frame: Bounds
  // Grid origin relative to the frame: piece.solved minus the bbox corner bakePiece drew from.
  anchor: Point
}

export interface AssembledAtlases {
  atlases: ImageBitmap[]
  pieces: AssembledPiece[]
}

export function assembleAtlases(pieces: PieceGeometry[], image: ImageBitmap, options: AssembleOptions = {}): AssembledAtlases {
  const baked: { piece: PieceGeometry; bitmap: ImageBitmap }[] = []
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!
    baked.push({ piece, bitmap: bakePiece(piece, image, options.cardboard) })

    const completed = i + 1
    if (options.onProgress && (completed % PROGRESS_INTERVAL === 0 || completed === pieces.length)) {
      options.onProgress(completed, pieces.length)
    }
  }

  const packed = packAtlas(
    baked.map(({ piece, bitmap }) => ({ id: piece.id, width: bitmap.width, height: bitmap.height })),
    options.atlas,
  )

  const sheets = Array.from({ length: packed.sheetCount }, () => new OffscreenCanvas(packed.sheetSize, packed.sheetSize))
  const contexts = sheets.map((sheet) => {
    const ctx = sheet.getContext('2d')
    if (ctx === null) throw new Error('this environment has no 2d canvas context')
    return ctx
  })

  const bakedById = new Map(baked.map((entry) => [entry.piece.id, entry]))
  const outPieces: AssembledPiece[] = []

  for (const placement of packed.placements) {
    const entry = bakedById.get(placement.id)!
    // Read before close: close is documented to release the bitmap's data, and nothing guarantees the
    // width and height getters still report the real size afterward rather than reading 0 like a
    // transferred bitmap does.
    const { width, height } = entry.bitmap

    contexts[placement.atlas]!.drawImage(entry.bitmap, placement.x, placement.y)
    // Composited into its sheet, so the intermediate per piece bitmap is not needed past this point.
    entry.bitmap.close()

    outPieces.push({
      id: entry.piece.id,
      atlas: placement.atlas,
      frame: { x: placement.x, y: placement.y, width, height },
      anchor: { x: entry.piece.solved.x - entry.piece.bbox.x, y: entry.piece.solved.y - entry.piece.bbox.y },
    })
  }

  // packAtlas places tallest first, not in id order. Everything downstream expects id order, the same
  // way createWarpedGridGeometry already publishes pieces.
  outPieces.sort((a, b) => a.id - b.id)

  return {
    atlases: sheets.map((sheet) => sheet.transferToImageBitmap()),
    pieces: outPieces,
  }
}
