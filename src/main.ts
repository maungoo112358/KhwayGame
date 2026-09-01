import { createApp } from './render/app'
import { createBoard } from './render/board'
import { createPipeline } from './render/pipeline'
import { createUploadZone } from './ui'
import { createSizePicker } from './ui/sizePicker'
import { chooseGrid, makeRng, workingSize, PUZZLE_BUILD_VERSION, type Grid } from './core'
import { createPuzzleState, scatterBounds, scatterPieces } from './state'

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

// A context-free stand in for the demo puzzle, so trying a small real puzzle needs no upload at all.
// Same shape as the placeholder lab/main.ts draws for the same reason, kept as its own small copy
// rather than shared, same as how lab and the game already each keep their own Worker instance.
async function demoImage(): Promise<ImageBitmap> {
  const source = document.createElement('canvas')
  source.width = 1600
  source.height = 1200

  const ctx = source.getContext('2d')
  if (ctx === null) throw new Error('this browser has no 2d canvas context')

  const sky = ctx.createLinearGradient(0, 0, 0, source.height)
  sky.addColorStop(0, '#6d9dc5')
  sky.addColorStop(1, '#e8c9a0')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, source.width, source.height)

  // Seeded, so the demo is the same picture every time rather than a surprise.
  const rng = makeRng(20260901, 'demo-puzzle')
  for (let i = 0; i < 16; i++) {
    ctx.beginPath()
    ctx.arc(rng.range(0, source.width), rng.range(0, source.height), rng.range(0.05, 0.16) * source.width, 0, Math.PI * 2)
    ctx.fillStyle = `hsl(${rng.range(0, 360).toFixed(0)} 55% 60% / 0.55)`
    ctx.fill()
  }

  return createImageBitmap(source)
}

// How many pieces the demo puzzle cuts into. Small enough that every piece scatters within easy reach
// on a normal, unmodified scatter, no special placement needed the way ?easyTest used to provide.
const DEMO_PIECE_COUNT = 10

// A2 through A4 of docs/phase8.md, chained: a size chosen for this image starts the real bake pipeline
// (treat then bake, both in the worker), and the result becomes a real board of real cardboard pieces
// the player can drag, snap and merge. targetPieces and initialGrid are kept separate rather than one
// GridOption, since the demo path has no size-picker band to carry, only a piece count and a grid.
async function startPuzzle(raw: ImageBitmap, targetPieces: number, initialGrid: Grid): Promise<void> {
  showStatus('preparing...')

  const size = workingSize(initialGrid)
  const { printed } = await pipeline.requestTreat(raw, size, (stage) => showStatus(`${stage}...`))

  // Re-derived against the treated image's own dimensions, same reasoning lab/main.ts uses: everything
  // after ingest works in working coordinates, not the upload's.
  const grid = chooseGrid(targetPieces, printed.width, printed.height)

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
  // Only a starting target, not the real result: scatterPieces shelf-packs and reports back the area it
  // actually used (PlacementBounds), which the camera has to be sized from, or panning would clip off
  // pieces sitting outside a guess made before anything was placed.
  const target = scatterBounds(bake.working)
  const tableBounds = scatterPieces(state, target, makeRng(seed, 'scatter'))

  createBoard(app, document.body, bake, state, tableBounds)
}

const upload = createUploadZone(
  (image) => {
    upload.element.remove()

    const sizePicker = createSizePicker(image, (option) => {
      sizePicker.element.remove()
      void startPuzzle(image, option.band.targetPieces, option.grid)
    })
    document.body.appendChild(sizePicker.element)
  },
  () => {
    upload.element.remove()
    void demoImage().then((image) => {
      const grid = chooseGrid(DEMO_PIECE_COUNT, image.width, image.height)
      void startPuzzle(image, DEMO_PIECE_COUNT, grid)
    })
  },
)
document.body.appendChild(upload.element)
