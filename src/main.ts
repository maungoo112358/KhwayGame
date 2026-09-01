import { createApp } from './render/app'
import { createBoard } from './render/board'
import { createPipeline } from './render/pipeline'
import { createUploadZone } from './ui'
import { createSizePicker } from './ui/sizePicker'
import { chooseGrid, makeRng, workingSize, PUZZLE_BUILD_VERSION, type GridOption } from './core'
import { createPuzzleState, scatterBounds, scatterPieces, scatterWithTestCluster } from './state'

// Standing debug aid, not a real gameplay mode: ?easyTest (optionally ?easyTest=15 for a bigger patch)
// pulls a small handful of real, mutually adjacent pieces into an easy-to-reach corner instead of
// scattering everything across the whole board, so the snap and merge mechanic can be tested by hand
// in seconds rather than by hunting through hundreds of scattered pieces. See docs/status.md.
const debugParams = new URLSearchParams(location.search)
const easyTestClusterSize = debugParams.has('easyTest') ? Number(debugParams.get('easyTest')) || 10 : null

const { app, backend } = await createApp(document.body)

console.log(`renderer backend: ${backend}`)
console.log(`core contract version: ${PUZZLE_BUILD_VERSION}`)

const worker = new Worker(new URL('./worker/treat-worker.ts', import.meta.url), { type: 'module' })
const pipeline = createPipeline(worker)

function showStatus(text: string): HTMLElement {
  let status = document.getElementById('status')
  if (status === null) {
    status = document.createElement('div')
    status.id = 'status'
    status.style.cssText = `
      position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      font: 16px system-ui, sans-serif; color: #4A443C;
    `
    document.body.appendChild(status)
  }
  status.textContent = text
  return status
}

// A2 through A4 of docs/phase8.md, chained: a size band chosen for this real upload starts the real
// bake pipeline (treat then bake, both in the worker), and the result becomes a real board of real
// cardboard pieces the player can drag, snap and merge.
async function startPuzzle(raw: ImageBitmap, option: GridOption): Promise<void> {
  showStatus('preparing...')

  const size = workingSize(option.grid)
  const { printed } = await pipeline.requestTreat(raw, size, (stage) => showStatus(`${stage}...`))

  // Re-derived against the treated image's own dimensions, same reasoning lab/main.ts and
  // stress/main.ts already use: everything after ingest works in working coordinates, not the upload's.
  const grid = chooseGrid(option.band.targetPieces, printed.width, printed.height)

  // A fresh seed per puzzle, not tied to the photo, so uploading the same photo twice cuts it
  // differently each time, the way buying two copies of a physical puzzle would not guarantee the same
  // cut. The seed itself still drives every deterministic thing downstream once chosen.
  const seed = Math.floor(Math.random() * 0xffffffff)

  const bake = await pipeline.requestBake(printed, grid, seed, undefined, undefined, (completed, total) => {
    showStatus(`baking ${completed} of ${total} pieces...`)
  })

  document.getElementById('status')?.remove()

  const state = createPuzzleState(bake)
  // Wider than bake.working on purpose: the solved size has zero slack, solved pieces tile it edge to
  // edge, so scattering into that exact area crams every piece on top of another. See scatterBounds.
  // Only a starting target, not the real result: scatterPieces/scatterWithTestCluster shelf-pack and
  // report back the area they actually used (PlacementBounds), which the camera has to be sized from,
  // or panning would clip off pieces sitting outside a guess made before anything was placed.
  const target = scatterBounds(bake.working)
  const tableBounds = easyTestClusterSize !== null
    ? scatterWithTestCluster(state, target, makeRng(seed, 'scatter'), easyTestClusterSize)
    : scatterPieces(state, target, makeRng(seed, 'scatter'))

  createBoard(app, document.body, bake, state, tableBounds)
}

const upload = createUploadZone((image) => {
  upload.element.remove()

  const sizePicker = createSizePicker(image, (option) => {
    sizePicker.element.remove()
    void startPuzzle(image, option)
  })
  document.body.appendChild(sizePicker.element)
})
document.body.appendChild(upload.element)
