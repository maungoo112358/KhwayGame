// Turning whatever the player uploaded into the image the bake actually works on.
//
// The rule: **working resolution is derived from the piece size, never from the upload.**
// A 6000px photo and a 4500px photo of the same shape produce the identical working image, because what matters is how many pixels a piece gets, not how many the camera had.
// Without that rule the atlas budget is set by whoever uploads the biggest file.

import { type Grid } from './lattice'

// How many pixels wide a piece should be at 100% zoom. Decided 2026-08-18.
//
// On a 1080p board showing 600 pieces at once a piece is about 64 screen pixels, so this leaves headroom to roughly 170% zoom before it softens.
// **Atlas cost scales with the square of this.** At 1000 pieces, 1000 * 110^2 is 12.1 million pixels of piece, against 33.5 million in two 4096 square sheets, which leaves room for tab overhang and packing waste.
// Dropping to 90 would roughly halve the VRAM. Revisit at 3.5, when the packer reports real efficiency rather than this estimate.
export const TARGET_PIECE_SIZE = 110

export interface WorkingSize {
  width: number
  height: number
  // Multiply source dimensions by this to get working ones. Never above 1.
  scale: number
  // What a piece really measures, as the side of a square of the same area. Equals the target unless the upload was too small to reach it.
  pieceSize: number
  // True when the upload was smaller than the working resolution and we declined to invent pixels. Pieces will be softer than the target and that is the honest outcome, not a failure.
  limitedBySource: boolean
}

// The whole of the arithmetic, kept apart from the browser call below so it can be tested without one.
export function workingSize(grid: Grid, targetPieceSize: number = TARGET_PIECE_SIZE): WorkingSize {
  if (!(targetPieceSize > 0)) {
    throw new Error(`target piece size must be positive, got ${targetPieceSize}`)
  }

  // The geometric mean of the two cell dimensions, which is the side of a square of the same area.
  // Using the mean rather than either axis on its own is what keeps the image's aspect ratio exactly intact.
  // Scaling to make cells exactly square would distort the photo by however far chooseGrid's rounding left them from square, up to about 5%, which is visible.
  const sourceCell = Math.sqrt(grid.cellWidth * grid.cellHeight)
  const wanted = targetPieceSize / sourceCell

  // Never upscale. Enlarging invents no detail, and it costs atlas space quadratically for the privilege.
  const scale = Math.min(wanted, 1)

  const width = Math.max(1, Math.round(grid.imageWidth * scale))
  const height = Math.max(1, Math.round(grid.imageHeight * scale))

  return {
    width,
    height,
    scale,
    // Measured back from the rounded result rather than assumed, so this reports what was achieved instead of what was asked for.
    pieceSize: Math.sqrt((width * height) / grid.pieceCount),
    limitedBySource: wanted > 1,
  }
}

// The resize itself. One call, hardware accelerated, and it works inside a Worker, which is where Phase 3.3 will run it.
export async function ingestImage(source: ImageBitmapSource, size: WorkingSize): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(source, {
    resizeWidth: size.width,
    resizeHeight: size.height,
    resizeQuality: 'high',
  })

  // The resize options are the least portable part of this pipeline, and a browser that ignores them returns the source at full size rather than failing.
  // Baking at the wrong resolution silently would blow the atlas budget and be very hard to trace, so it fails loudly here instead. See the portability note in docs/ARCHITECTURE.md.
  if (bitmap.width !== size.width || bitmap.height !== size.height) {
    bitmap.close()
    throw new Error(
      `this browser ignored createImageBitmap resize options: asked for ${size.width} by ${size.height}, got ${bitmap.width} by ${bitmap.height}`,
    )
  }

  return bitmap
}
