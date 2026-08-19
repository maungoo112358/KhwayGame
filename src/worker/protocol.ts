// The wire format between the lab (main thread) and the treat worker.
// Both sides import these types, so a mismatched message shape is a compile error rather than something noticed at runtime.

import type { WorkingSize } from '../core'

export interface TreatRequest {
  type: 'treat'
  source: ImageBitmap
  size: WorkingSize
}

// Two stages today, ingest then print, both under 100ms on the placeholder.
// Real granularity is a 3.6 problem, once baking 1000 pieces takes seconds rather than milliseconds.
export type TreatResponse =
  | { type: 'progress'; stage: 'ingest' | 'print'; fraction: number }
  | { type: 'result'; plain: ImageBitmap; printed: ImageBitmap; printMs: number }
  | { type: 'error'; message: string }
