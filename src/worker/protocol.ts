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
  | { type: 'result'; atlases: ImageBitmap[]; pieces: AssembledPiece[]; bakeMs: number }
  | { type: 'error'; message: string }
