// Runs entirely inside a Worker. Compiled by src/worker/tsconfig.json, which swaps the DOM lib for WebWorker,
// same as core/tsconfig.json, so document and window do not exist here either.
//
// Three request types. `treat`: ingest and print treatment, the pipe proved out at 3.3. `bake`: geometry
// plus the full bake and atlas assembly from 3.4 through 3.6, chained in one run. `kuwahara`: the optional
// painterly pass, against an already ingested image, kept separate from `treat` since it is not free the
// way print treatment is. Progress reported, results handed back transferred rather than cloned.

import { assembleAtlases, createWarpedGridGeometry, ingestImage, kuwaharaGeneralizedTreat, kuwaharaTreat, printTreat } from '../core'
import type { BakeRequest, BakeResponse, KuwaharaRequest, KuwaharaResponse, TreatRequest, TreatResponse } from './protocol'

function reply(message: TreatResponse | BakeResponse | KuwaharaResponse, transfer: Transferable[] = []): void {
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

function handleKuwahara(request: KuwaharaRequest): void {
  const { image, radius, variant } = request

  reply({ type: 'progress', stage: 'style', fraction: 0 })
  const started = performance.now()
  const stylized = variant === 'classic' ? kuwaharaTreat(image, { radius }) : kuwaharaGeneralizedTreat(image, { radius })
  const styleMs = performance.now() - started

  reply({ type: 'progress', stage: 'print', fraction: 0.8 })
  const stylizedPrinted = printTreat(stylized)

  reply({ type: 'result', stylized, stylizedPrinted, styleMs }, [stylized, stylizedPrinted])
}

self.onmessage = async (event: MessageEvent<TreatRequest | BakeRequest | KuwaharaRequest>) => {
  try {
    if (event.data.type === 'treat') {
      await handleTreat(event.data)
    } else if (event.data.type === 'bake') {
      handleBake(event.data)
    } else {
      handleKuwahara(event.data)
    }
  } catch (err) {
    reply({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
