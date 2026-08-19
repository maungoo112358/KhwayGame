// Runs entirely inside a Worker. Compiled by src/worker/tsconfig.json, which swaps the DOM lib for WebWorker,
// same as core/tsconfig.json, so document and window do not exist here either.
//
// No cutting yet, this is the pipe. Receive an image, run the two passes core/ already has, report progress,
// hand the result back transferred rather than cloned.

import { ingestImage, printTreat } from '../core'
import type { TreatRequest, TreatResponse } from './protocol'

function reply(message: TreatResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer)
}

self.onmessage = async (event: MessageEvent<TreatRequest>) => {
  const { source, size } = event.data

  try {
    reply({ type: 'progress', stage: 'ingest', fraction: 0 })
    const plain = await ingestImage(source, size)

    reply({ type: 'progress', stage: 'print', fraction: 0.5 })
    const started = performance.now()
    const printed = printTreat(plain)
    const printMs = performance.now() - started

    // Both bitmaps are transferred, not cloned. Neither is needed on this side once they are sent.
    reply({ type: 'result', plain, printed, printMs }, [plain, printed])
  } catch (err) {
    reply({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
