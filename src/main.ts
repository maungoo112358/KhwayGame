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

// A fixed real photo for the demo puzzle, not a fresh upload: the point of this path is a puzzle the
// user can play the same way run after run to judge a fix, so both the picture and DEMO_SEED below are
// constants, never randomised. Served from public/, same as index.html and lab.html sit at the site
// root, so this resolves identically in dev and in the built dist/.
const DEMO_IMAGE_URL = '/demo-puzzle.jpg'

async function demoImage(): Promise<ImageBitmap> {
  const response = await fetch(DEMO_IMAGE_URL)
  const blob = await response.blob()
  return createImageBitmap(blob)
}

// How many pieces the demo puzzle cuts into. Small enough that every piece scatters within easy reach
// on a normal, unmodified scatter, no special placement needed the way ?easyTest used to provide.
const DEMO_PIECE_COUNT = 10
// Fixed, not Math.random() like a real upload gets: the same seed plus the same image is what makes two
// runs of the demo produce the identical cut and the identical scatter, so a fix can actually be judged
// against a repeat of the same result rather than a new shuffle every time.
const DEMO_SEED = 20260901

// A2 through A4 of docs/phase8.md, chained: a size chosen for this image starts the real bake pipeline
// (treat then bake, both in the worker), and the result becomes a real board of real cardboard pieces
// the player can drag, snap and merge. targetPieces and initialGrid are kept separate rather than one
// GridOption, since the demo path has no size-picker band to carry, only a piece count and a grid. seed
// is the caller's choice too now: a real upload still wants a fresh one every time, the demo wants the
// same one every time, see DEMO_SEED.
async function startPuzzle(raw: ImageBitmap, targetPieces: number, initialGrid: Grid, seed: number): Promise<void> {
  showStatus('preparing...')

  const size = workingSize(initialGrid)
  const { printed } = await pipeline.requestTreat(raw, size, (stage) => showStatus(`${stage}...`))

  // Re-derived against the treated image's own dimensions, same reasoning lab/main.ts uses: everything
  // after ingest works in working coordinates, not the upload's.
  const grid = chooseGrid(targetPieces, printed.width, printed.height)

  // requestBake transfers printed into the worker, which is dead on this side the moment that call is
  // made, by design, that is how the zero-copy gate proves itself. render/board.ts needs the same
  // treated photo later, to re-bake a piece when it connects to a neighbour, so an independent copy is
  // made first and kept alive for the life of the board, same technique lab/main.ts already uses to keep
  // its own upload alive across a transfer.
  const bakeSource = await createImageBitmap(printed)

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

  createBoard(app, document.body, bake, state, tableBounds, bakeSource)
}

const upload = createUploadZone(
  (image) => {
    upload.element.remove()

    const sizePicker = createSizePicker(image, (option) => {
      sizePicker.element.remove()
      // A fresh seed per puzzle, not tied to the photo, so uploading the same photo twice cuts it
      // differently each time, the way buying two copies of a physical puzzle would not guarantee the
      // same cut.
      const seed = Math.floor(Math.random() * 0xffffffff)
      void startPuzzle(image, option.band.targetPieces, option.grid, seed)
    })
    document.body.appendChild(sizePicker.element)
  },
  () => {
    upload.element.remove()
    void demoImage().then((image) => {
      const grid = chooseGrid(DEMO_PIECE_COUNT, image.width, image.height)
      void startPuzzle(image, DEMO_PIECE_COUNT, grid, DEMO_SEED)
    })
  },
)
document.body.appendChild(upload.element)
