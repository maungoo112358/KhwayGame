// Runs entirely inside a Worker. Compiled by src/worker/tsconfig.json, which swaps the DOM lib for WebWorker,
// same as core/tsconfig.json, so document and window do not exist here either.
//
// Two request types. `treat`: ingest and print treatment, the pipe proved out at 3.3. `bake`: geometry
// plus the full bake and atlas assembly from 3.4 through 3.6, chained in one run. Progress reported,
// results handed back transferred rather than cloned.

import { assembleAtlases, createWarpedGridGeometry, ingestImage, printTreat } from '../core'
import type { BakeRequest, BakeResponse, TreatRequest, TreatResponse } from './protocol'

function reply(message: TreatResponse | BakeResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer)
}

async function handleTreat(request: TreatRequest): Promise<void> {
  const { source, size } = request

  reply({ type: 'progress', stage: 'ingest', fraction: 0 })
  const plain = await ingestImage(source, size)

  reply({ type: 'progress', stage: 'print', fraction: 0.5 })
  const started = performance.now()
  const printed = printTreat(plain)
  const printMs = performance.now() - started

  // Both bitmaps are transferred, not cloned. Neither is needed on this side once they are sent.
  reply({ type: 'result', plain, printed, printMs }, [plain, printed])
}

function handleBake(request: BakeRequest): void {
  const { image, grid, seed, warp, tabs } = request

  const pieces = createWarpedGridGeometry({ grid, seed, warp, tabs }).pieces()

  const started = performance.now()
  const { atlases, pieces: assembled } = assembleAtlases(pieces, image, {
    onProgress: (completed, total) => reply({ type: 'progress', stage: 'baking', completed, total }),
  })
  const bakeMs = performance.now() - started

  reply({ type: 'result', atlases, pieces: assembled, bakeMs }, atlases)
}

self.onmessage = async (event: MessageEvent<TreatRequest | BakeRequest>) => {
  try {
    if (event.data.type === 'treat') {
      await handleTreat(event.data)
    } else {
      handleBake(event.data)
    }
  } catch (err) {
    reply({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
