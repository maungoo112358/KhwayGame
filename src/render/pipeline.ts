// Runs the real bake pipeline for the real game: upload to ingest/treat to bake, both stages via the
// worker. Same round trip src/lab/main.ts and src/stress/main.ts already proved out, written fresh
// here rather than shared with them: each Vite entry point gets its own Worker instance, since each is
// its own independent module graph (docs/roadmap.md, Phase 1), so there is nothing to share but the
// small wrapper around postMessage, and each of the three pages already keeps its own copy of that.

import type { Grid, TabOptions, WarpOptions, WorkingSize } from '../core'
import type { BakeRequest, BakeResponse, TreatRequest, TreatResponse } from '../worker/protocol'

export type BakeResult = BakeResponse & { type: 'result' }

export interface Pipeline {
  requestTreat(source: ImageBitmap, size: WorkingSize, onProgress?: (stage: string) => void): Promise<{ plain: ImageBitmap; printed: ImageBitmap; printMs: number }>
  requestBake(image: ImageBitmap, grid: Grid, seed: number, warp: WarpOptions | undefined, tabs: TabOptions | undefined, onProgress?: (completed: number, total: number) => void): Promise<BakeResult>
}

export function createPipeline(worker: Worker): Pipeline {
  function requestTreat(source: ImageBitmap, size: WorkingSize, onProgress?: (stage: string) => void): Promise<{ plain: ImageBitmap; printed: ImageBitmap; printMs: number }> {
    return new Promise((resolve, reject) => {
      function handleMessage(event: MessageEvent<TreatResponse>): void {
        const message = event.data
        if (message.type === 'progress') {
          onProgress?.(message.stage)
          return
        }

        worker.removeEventListener('message', handleMessage)
        if (message.type === 'error') reject(new Error(message.message))
        else resolve(message)
      }

      worker.addEventListener('message', handleMessage)
      const request: TreatRequest = { type: 'treat', source, size }
      worker.postMessage(request, [source])

      // Same zero-copy proof lab/main.ts and stress/main.ts already assert: postMessage without a
      // transfer list silently full-copies, which at several megapixels is real, wasted work.
      if (source.width !== 0) {
        throw new Error('pipeline transfer did not neuter the source bitmap, zero copy gate failed')
      }
    })
  }

  function requestBake(image: ImageBitmap, grid: Grid, seed: number, warp: WarpOptions | undefined, tabs: TabOptions | undefined, onProgress?: (completed: number, total: number) => void): Promise<BakeResult> {
    return new Promise((resolve, reject) => {
      function handleMessage(event: MessageEvent<BakeResponse>): void {
        const message = event.data
        if (message.type === 'progress') {
          onProgress?.(message.completed, message.total)
          return
        }

        worker.removeEventListener('message', handleMessage)
        if (message.type === 'error') reject(new Error(message.message))
        else resolve(message)
      }

      worker.addEventListener('message', handleMessage)
      const request: BakeRequest = { type: 'bake', image, grid, seed, warp, tabs }
      worker.postMessage(request, [image])

      if (image.width !== 0) {
        throw new Error('pipeline transfer did not neuter the source bitmap, zero copy gate failed')
      }
    })
  }

  return { requestTreat, requestBake }
}
