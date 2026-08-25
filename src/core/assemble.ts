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

import { isEdgePiece, type Neighbors, type PieceGeometry } from './geometry'
import type { Bounds } from './pieces'
import type { Grid, Point } from './lattice'
import { bakePiece, pieceAlphaMask, pieceDominantColor, type CardboardOptions, type AlphaMask } from './bake'
import { packAtlas, type AtlasOptions } from './atlas'
import { mix32 } from './rng'

// Bumped whenever the shape of PuzzleBuild changes, so old saves can be rejected instead of silently misinterpreted.
// See docs/ARCHITECTURE.md.
export const PUZZLE_BUILD_VERSION = 1

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
  row: number
  col: number
  solved: Point
  neighbors: Neighbors
  isEdge: boolean
  dominantColor: number
  alphaMask: AlphaMask
}

export interface PuzzleBuild {
  atlases: ImageBitmap[]
  pieces: AssembledPiece[]
  version: number
  signature: string
  seed: number
  grid: {cols: number; rows: number}
  working: {w: number; h: number}
}

export function assembleAtlases(pieces: PieceGeometry[], image: ImageBitmap, grid: Grid, seed: number, options: AssembleOptions = {}): PuzzleBuild {

  const baked: { piece: PieceGeometry; bitmap: ImageBitmap; dominantColor: number; isEdge: boolean; alphaMask: AlphaMask; }[] = []

  const canvas = new OffscreenCanvas(image.width, image.height);

  const ctx = canvas.getContext('2d')
  if(ctx === null)  throw new Error('this environment has no 2d canvas context')
  ctx.save();
  ctx.drawImage(image, 0,0);
  ctx.restore();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!
    const dominantColor = pieceDominantColor(piece,image);
    const isEdge = isEdgePiece(piece.neighbors);
    const alphaMask = pieceAlphaMask(piece);
    baked.push({ piece, bitmap: bakePiece(piece, image, options.cardboard), dominantColor, isEdge, alphaMask })
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
      row: entry.piece.row,
      col: entry.piece.col,
      solved: entry.piece.solved,
      neighbors: entry.piece.neighbors,
      isEdge: entry.isEdge,
      dominantColor: entry.dominantColor,
      alphaMask: entry.alphaMask
    })
  }

  // packAtlas places tallest first, not in id order. Everything downstream expects id order, the same
  // way createWarpedGridGeometry already publishes pieces.
  outPieces.sort((a, b) => a.id - b.id)

  return {
    atlases: sheets.map((sheet) => sheet.transferToImageBitmap()),
    pieces: outPieces,
    version: PUZZLE_BUILD_VERSION,
    signature: hashImage(pixels, seed, grid).toString(16),
    seed: seed,
    grid: {cols: grid.cols, rows: grid.rows},
    working:{w:grid.imageWidth,h:grid.imageHeight}
  }
}


export function hashImage(pixels: Uint8ClampedArray,seed: number,grid: Grid): number {
  let h = mix32(seed);
  for (let i = 0; i < pixels.length; i++) {
    h = mix32(h ^ pixels[i]!);
  }
   h = mix32(h ^ grid.cols)
   h = mix32(h ^ grid.rows);
  return h;
}
