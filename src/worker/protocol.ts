// The wire format between the lab (main thread) and the treat worker.
// Both sides import these types, so a mismatched message shape is a compile error rather than something noticed at runtime.

import type { AssembledPiece, Grid, TabOptions, WarpOptions, WorkingSize } from '../core'

export interface TreatRequest {
  type: 'treat'
  source: ImageBitmap
  size: WorkingSize
}

// Two stages today, ingest then print, both under 100ms on the placeholder.
export type TreatResponse =
  | { type: 'progress'; stage: 'ingest' | 'print'; fraction: number }
  | { type: 'result'; plain: ImageBitmap; printed: ImageBitmap; printMs: number }
  | { type: 'error'; message: string }

export interface BakeRequest {
  type: 'bake'
  image: ImageBitmap
  grid: Grid
  seed: number
  warp?: WarpOptions
  tabs?: TabOptions
}

// One progress event every so often while baking, not one per piece. At 1000 pieces that would be 1000
// postMessage calls competing with the baking itself for the thread.
export type BakeResponse =
  | { type: 'progress'; stage: 'baking'; completed: number; total: number }
  | { type: 'result'; atlases: ImageBitmap[]; pieces: AssembledPiece[]; bakeMs: number; working: {w:number; h:number} }
  | { type: 'error'; message: string }

// Separate from `treat`: this runs against an already ingested image, not a raw upload, so it never
// redoes the decode. Deliberately not folded into the automatic treat pipeline either, since radius is a
// slider and print treatment is not, recomputing on every band change the way print treatment safely
// does would mean paying the (optimised, but not free) filter cost even when the toggle is off.
export interface KuwaharaRequest {
  type: 'kuwahara'
  image: ImageBitmap
  radius: number
  // One request type for both, rather than a fourth message type, since the request and response shapes
  // are otherwise identical, only which core function gets called differs.
  variant: 'classic' | 'generalized'
}

export type KuwaharaResponse =
  | { type: 'progress'; stage: 'style' | 'print'; fraction: number }
  | { type: 'result'; stylized: ImageBitmap; stylizedPrinted: ImageBitmap; styleMs: number }
  | { type: 'error'; message: string }
