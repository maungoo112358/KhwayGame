import {
  bakePiece,
  chooseGrid,
  createWarpedGridGeometry,
  gridOptions,
  makeRng,
  workingSize,
  type Grid,
  type GridOption,
  type PieceGeometry,
  type WorkingSize,
} from '../core'
import type { BakeRequest, BakeResponse, TreatRequest, TreatResponse } from '../worker/protocol'

// The lab is a separate Vite entry point, not a route inside the game.
// It may import core/ and a thin slice of render/, and nothing may import it.
// That is what keeps it working while ui/ is being torn apart.
//
// The one idea in this file: everything is drawn in image pixel coordinates.
// core/ emits vertices in image space, the canvas transform is set once per frame, and no other line of code converts between spaces.
// A puzzle can be 6000px wide on a 900px canvas, and the only place that ratio appears is the setTransform call.

function need<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) throw new Error(`lab.html is missing ${selector}`)
  return element
}

const canvas = need<HTMLCanvasElement>('#canvas')
const output = need<HTMLDivElement>('#output')
const fileInput = need<HTMLInputElement>('#file')
const bandSelect = need<HTMLSelectElement>('#band')
const warpInput = need<HTMLInputElement>('#warp')
const warpValue = need<HTMLSpanElement>('#warpValue')
const tabSizeInput = need<HTMLInputElement>('#tabSize')
const tabSizeValue = need<HTMLSpanElement>('#tabSizeValue')
const tabVarianceInput = need<HTMLInputElement>('#tabVariance')
const tabVarianceValue = need<HTMLSpanElement>('#tabVarianceValue')
const gapInput = need<HTMLInputElement>('#gap')
const gapValue = need<HTMLSpanElement>('#gapValue')
const printInput = need<HTMLInputElement>('#print')
const pieceControls = need<HTMLSpanElement>('#pieceControls')
const bakePreviewInput = need<HTMLInputElement>('#bakePreview')
const backToPuzzleButton = need<HTMLButtonElement>('#backToPuzzle')
const resetViewButton = need<HTMLButtonElement>('#resetView')
const bakeFullButton = need<HTMLButtonElement>('#bakeFull')
const closeAtlasButton = need<HTMLButtonElement>('#closeAtlas')
const zoomValue = need<HTMLSpanElement>('#zoomValue')
const readout = need<HTMLSpanElement>('#readout')

// A function rather than an inline null check, because narrowing a module level const does not follow into function bodies.
function context2d(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = target.getContext('2d')
  if (ctx === null) throw new Error('this browser has no 2d canvas context')
  return ctx
}

const context = context2d(canvas)

// How far apart to push neighbouring pieces, in image pixels, so the cut is visible.
// At zero the pieces tile back into the original image exactly, which is the property pieces.test.ts proves by area, and is the setting to judge the cut on.
// Not a geometry knob: changing it only moves pieces around, so it redraws without rebuilding anything.
let gap = Number(gapInput.value)

// Fixed, so the same image always cuts the same way and a changed picture is never the seed's fault.
const SEED = 20260818

const MIN_ZOOM = 1
const MAX_ZOOM = 40
const ZOOM_STEP = 1.15

// The view. zoom multiplies the fit-to-window scale, and pan is the content coordinate sitting at the canvas's top left corner.
// Keeping pan in content coordinates rather than screen pixels means zooming does not have to rescale it.
let zoom = 1
let panX = 0
let panY = 0

// What draw() last computed, so the pointer handlers can convert screen coordinates back into content coordinates without recomputing the fit.
let viewScale = 1

// The upload, kept only so a change of size band can re-ingest from it. Nothing draws from it.
let source: ImageBitmap | null = null

// The working image in both states, so the toggle is instant. The real pipeline only ever keeps the treated one.
let plain: ImageBitmap | null = null
let printed: ImageBitmap | null = null
let workingGrid: Grid | null = null

// Which piece, if any, is isolated for inspection. An index into pieces, not an id, since that is what
// both the pieces and hitPaths arrays are keyed by.
let isolatedIndex: number | null = null

// The baked cardboard for the isolated piece only, rebuilt whenever it, or the treated image, changes.
// null whenever nothing is isolated or the toggle is off.
let bakedPiece: ImageBitmap | null = null

// The real atlas sheets from a full bake, empty until "Bake full puzzle" is clicked. Takes over the
// whole canvas when present, above even the isolated piece view.
let atlasSheets: ImageBitmap[] = []

let pieces: PieceGeometry[] = []
// One Path2D per piece, in image space with the gap explosion already baked in, so a double click can
// be tested against them directly. Rebuilt whenever geometry or gap changes, not on every pointer move.
let hitPaths: Path2D[] = []
let columns = 0
let rows = 0
let options: GridOption[] = []

// Which band the player picked, kept across image changes so choosing a new photo does not silently reset the size.
let selectedBandId = 'medium'

// A new image means new options, because the aspect ratio drives cols and rows and therefore the true piece count.
function setImage(bitmap: ImageBitmap): void {
  source = bitmap
  options = gridOptions(bitmap.width, bitmap.height)

  // Each entry carries the count this image really produces, so nothing has to be corrected after the fact.
  bandSelect.replaceChildren(
    ...options.map(({ band, grid }) => {
      const option = document.createElement('option')
      option.value = band.id
      option.textContent = `${band.name}, ${grid.pieceCount} pieces (${grid.cols} by ${grid.rows})`
      return option
    }),
  )
  bandSelect.value = selectedBandId

  // A new image is a new subject, so the old zoom and pan mean nothing. Changing a slider keeps the view, since you are usually watching one spot while you drag.
  zoom = 1
  panX = 0
  panY = 0

  // Whatever was isolated, or baked, belonged to the old image's geometry, and no longer means anything.
  isolatedIndex = null
  pieceControls.style.display = 'none'
  bakePreviewInput.checked = false
  for (const sheet of atlasSheets) sheet.close()
  atlasSheets = []
  closeAtlasButton.style.display = 'none'

  void applyBand()
}

// Re-ingest at the working resolution the chosen band asks for.
//
// Only the band moves this, so it is separate from rebuild: dragging the warp slider must not re-decode the image.
// Everything after this point works in working coordinates, which is why the grid is measured against the downscaled image rather than the upload.
async function applyBand(): Promise<void> {
  if (source === null) return

  const chosen = options.find(({ band }) => band.id === selectedBandId)
  if (chosen === undefined) return

  const size = workingSize(chosen.grid)

  // `source` is kept alive here for the next band change, so the worker gets an independent copy to consume.
  // Timed because this is the first pass in the project that touches every pixel, and 3.6 has a five second budget for the whole bake.
  const clone = await createImageBitmap(source)
  const result = await treatInWorker(clone, size)

  plain = result.plain
  printed = result.printed

  workingGrid = chooseGrid(chosen.band.targetPieces, size.width, size.height)

  reportIngest(chosen.grid, size, result.printMs)
  rebuild()
}

// One worker for the lab's whole lifetime. There is never more than one treat in flight, so no pool is needed yet.
const treatWorker = new Worker(new URL('../worker/treat-worker.ts', import.meta.url), { type: 'module' })

function treatInWorker(source: ImageBitmap, size: WorkingSize): Promise<{ plain: ImageBitmap; printed: ImageBitmap; printMs: number }> {
  return new Promise((resolve, reject) => {
    function handleMessage(event: MessageEvent<TreatResponse>): void {
      const message = event.data
      if (message.type === 'progress') {
        readout.textContent = `${message.stage}...`
        return
      }

      treatWorker.removeEventListener('message', handleMessage)
      if (message.type === 'error') {
        reject(new Error(message.message))
      } else {
        resolve(message)
      }
    }

    treatWorker.addEventListener('message', handleMessage)

    const request: TreatRequest = { type: 'treat', source, size }
    treatWorker.postMessage(request, [source])

    // Proof rather than assumption: a transferred bitmap is neutered on this side the instant postMessage returns.
    if (source.width !== 0) {
      throw new Error('treat worker transfer did not neuter the source bitmap, zero copy gate failed')
    }
  })
}

function reportIngest(sourceGrid: Grid, size: WorkingSize, printMs: number): void {
  const limited = size.limitedBySource ? ', upload too small to reach the target' : ''
  const megapixels = (size.width * size.height) / 1e6

  readout.textContent =
    `source ${sourceGrid.imageWidth} by ${sourceGrid.imageHeight}` +
    ` to working ${size.width} by ${size.height} (${(size.scale * 100).toFixed(0)}%)` +
    `, pieces ${size.pieceSize.toFixed(1)}px${limited}` +
    `, print pass ${printMs.toFixed(0)}ms for ${megapixels.toFixed(1)}MP`
}

function rebuild(): void {
  if (workingGrid === null) return

  // Sliders are in whole percent and core wants fractions. The warp ceiling of 40 matches MAX_AMPLITUDE and the variance ceiling of 50 matches MAX_VARIANCE.
  const amplitude = Number(warpInput.value) / 100
  const size = Number(tabSizeInput.value) / 100
  const variance = Number(tabVarianceInput.value) / 100

  warpValue.textContent = `${warpInput.value}%`
  tabSizeValue.textContent = `${tabSizeInput.value}%`
  tabVarianceValue.textContent = `${tabVarianceInput.value}%`

  // One call. The lab does not know there is a lattice, a noise field or a bezier behind this, which is the entire point of the seam.
  pieces = createWarpedGridGeometry({
    grid: workingGrid,
    seed: SEED,
    warp: { amplitude },
    tabs: { size, variance },
  }).pieces()
  columns = workingGrid.cols
  rows = workingGrid.rows

  rebuildHitPaths()

  // The old selection may no longer exist, a smaller band can shrink pieces.length past it.
  if (isolatedIndex !== null && isolatedIndex >= pieces.length) exitIsolation()

  updateBakePreview()
  draw()
}

// One Path2D per piece so a double click can be tested with isPointInPath instead of hand rolled point
// in polygon math. Coordinates already include the gap explosion, matching exactly where drawPiece puts
// each piece, so a hit test and a draw never disagree about where a piece actually is.
function rebuildHitPaths(): void {
  hitPaths = pieces.map((piece) => {
    const path = new Path2D()
    const dx = piece.col * gap
    const dy = piece.row * gap
    const first = piece.path[0]!
    path.moveTo(first.x + dx, first.y + dy)
    for (let i = 1; i < piece.path.length; i++) {
      const point = piece.path[i]!
      path.lineTo(point.x + dx, point.y + dy)
    }
    path.closePath()
    return path
  })
}

function enterIsolation(index: number): void {
  isolatedIndex = index
  zoom = 1
  panX = 0
  panY = 0
  pieceControls.style.display = ''
  bakePreviewInput.checked = false
  updateBakePreview()
  draw()
}

function exitIsolation(): void {
  isolatedIndex = null
  zoom = 1
  panX = 0
  panY = 0
  pieceControls.style.display = 'none'
  bakePreviewInput.checked = false
  updateBakePreview()
  draw()
}

// Only the isolated piece is ever baked, not the whole board: a real photo can be hundreds of pieces,
// and the question right now is whether one piece reads as cardboard, not how fast a full bake runs.
function updateBakePreview(): void {
  if (bakedPiece !== null) {
    bakedPiece.close()
    bakedPiece = null
  }

  if (isolatedIndex === null || !bakePreviewInput.checked) return

  const image = printInput.checked ? printed : plain
  if (image === null) return

  const piece = pieces[isolatedIndex]
  if (piece === undefined) return

  bakedPiece = bakePiece(piece, image)
}

function closeAtlasView(): void {
  for (const sheet of atlasSheets) sheet.close()
  atlasSheets = []
  closeAtlasButton.style.display = 'none'

  zoom = 1
  panX = 0
  panY = 0
  draw()
}

// Sends the whole current puzzle, geometry and all, to the worker for a real bake: every piece baked,
// packed, and composited into real atlas sheets. The worker rebuilds geometry itself from grid, seed and
// the current slider values rather than the lab shipping its already built pieces array across, since
// PieceGeometry is a plain object graph the worker can reconstruct identically from the same seed anyway.
async function bakeFullPuzzle(): Promise<void> {
  if (workingGrid === null) return

  const image = printInput.checked ? printed : plain
  if (image === null) return

  if (isolatedIndex !== null) exitIsolation()

  const clone = await createImageBitmap(image)

  const request: BakeRequest = {
    type: 'bake',
    image: clone,
    grid: workingGrid,
    seed: SEED,
    warp: { amplitude: Number(warpInput.value) / 100 },
    tabs: { size: Number(tabSizeInput.value) / 100, variance: Number(tabVarianceInput.value) / 100 },
  }

  bakeFullButton.disabled = true
  readout.textContent = 'baking...'

  try {
    const response = await new Promise<BakeResponse & { type: 'result' }>((resolve, reject) => {
      function handleMessage(event: MessageEvent<BakeResponse>): void {
        const message = event.data
        if (message.type === 'progress') {
          readout.textContent = `baking ${message.completed} of ${message.total} pieces...`
          return
        }

        treatWorker.removeEventListener('message', handleMessage)
        if (message.type === 'error') {
          reject(new Error(message.message))
        } else {
          resolve(message)
        }
      }

      treatWorker.addEventListener('message', handleMessage)
      treatWorker.postMessage(request, [clone])

      // Same zero copy proof as treatInWorker: the clone must be dead on this side the instant postMessage returns.
      if (clone.width !== 0) {
        throw new Error('bake worker transfer did not neuter the source bitmap, zero copy gate failed')
      }
    })

    for (const sheet of atlasSheets) sheet.close()
    atlasSheets = response.atlases

    const pieceCount = response.pieces.length
    const sheetWord = response.atlases.length === 1 ? 'sheet' : 'sheets'
    readout.textContent = `baked ${pieceCount} pieces into ${response.atlases.length} ${sheetWord} in ${response.bakeMs.toFixed(0)}ms`

    closeAtlasButton.style.display = ''
    zoom = 1
    panX = 0
    panY = 0
    draw()
  } finally {
    bakeFullButton.disabled = false
  }
}

// Shared by the whole puzzle view and the isolated single piece view: fits content to the viewport,
// sets up the transform, then hands back to the caller to paint in content coordinates.
//
// allowUpscale lets the isolated view grow past 1:1. A single ~110px piece needs to be blown up to be
// worth looking at, unlike the whole puzzle, which should never enlarge past its native resolution.
function drawContent(contentWidth: number, contentHeight: number, allowUpscale: boolean, paint: () => void): void {
  // Reading clientWidth of the parent rather than of the canvas avoids a feedback loop, since a block div's width does not depend on how wide its children are.
  const widthBudget = output.clientWidth
  const heightBudget = Math.max(240, window.innerHeight - output.getBoundingClientRect().top - 40)
  const fitScale = allowUpscale
    ? Math.min(widthBudget / contentWidth, heightBudget / contentHeight)
    : Math.min(widthBudget / contentWidth, heightBudget / contentHeight, 1)
  const scale = fitScale * zoom
  viewScale = scale

  // The canvas is a window onto the content rather than the content itself.
  // At zoom 1 the drawn size is never bigger than the budget, so it comes out exactly content sized, which is how it behaved before zooming existed.
  const viewWidth = Math.min(contentWidth * scale, widthBudget)
  const viewHeight = Math.min(contentHeight * scale, heightBudget)

  // Pan cannot go past the edges of the content, so the puzzle can never be lost off screen.
  panX = clamp(panX, 0, Math.max(0, contentWidth - viewWidth / scale))
  panY = clamp(panY, 0, Math.max(0, contentHeight - viewHeight / scale))

  // Two different sizes on purpose. The style is in CSS pixels, the attributes are the real pixel buffer, and on a 2x display those differ by the device pixel ratio.
  // Skipping this is what makes canvas lines look soft on a high dpi screen.
  const dpr = window.devicePixelRatio || 1
  const bufferWidth = Math.round(viewWidth * dpr)
  const bufferHeight = Math.round(viewHeight * dpr)

  canvas.style.width = `${viewWidth}px`
  canvas.style.height = `${viewHeight}px`

  // Only reassigned when it actually changed. Writing canvas.width reallocates the buffer, and this now runs on every drag frame.
  if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
    canvas.width = bufferWidth
    canvas.height = bufferHeight
  }

  // Assigning canvas.width resets the whole context state, transform included, so this has to come after.
  // The last two arguments are the translation, which is what pans: shifting the origin left by the panned distance.
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.setTransform(scale * dpr, 0, 0, scale * dpr, -panX * scale * dpr, -panY * scale * dpr)

  zoomValue.textContent = `${Math.round(zoom * 100)}%`

  paint()
}

// How far apart the atlas sheets sit from each other in the atlas view. Not the piece gap slider, that
// means something else, exploding pieces apart within one sheet, not spacing whole sheets apart.
const ATLAS_GAP = 24

function draw(): void {
  if (atlasSheets.length > 0) {
    const contentWidth = atlasSheets.reduce((sum, sheet) => sum + sheet.width, 0) + (atlasSheets.length - 1) * ATLAS_GAP
    const contentHeight = Math.max(...atlasSheets.map((sheet) => sheet.height))

    drawContent(contentWidth, contentHeight, false, () => {
      let x = 0
      for (const sheet of atlasSheets) {
        context.drawImage(sheet, x, 0)
        x += sheet.width + ATLAS_GAP
      }
    })
    return
  }

  // Which of the two working images to draw. The pieces are identical either way, since the treatment changes colour and not geometry.
  const image = printInput.checked ? printed : plain
  if (image === null || pieces.length === 0) return

  if (isolatedIndex !== null) {
    const piece = pieces[isolatedIndex]
    if (piece === undefined) return

    // The content box is the piece's own bbox, not the whole exploded puzzle, and upscaling is allowed
    // so a ~110px piece is actually worth looking at.
    drawContent(piece.bbox.width, piece.bbox.height, true, () => {
      if (bakedPiece !== null) {
        context.drawImage(bakedPiece, 0, 0)
        return
      }

      context.lineWidth = 1 / viewScale
      context.strokeStyle = 'rgb(30 26 22 / 0.35)'
      // Translating by the negative bbox corner instead of the usual gap offset lands this one piece at
      // the content origin, since it is the only thing being drawn.
      drawPiece(context, piece, image, -piece.bbox.x, -piece.bbox.y)
    })
    return
  }

  // Pushing pieces apart makes the drawing wider than the image, so the fit is computed against the exploded size rather than the source.
  const contentWidth = image.width + (columns - 1) * gap
  const contentHeight = image.height + (rows - 1) * gap

  drawContent(contentWidth, contentHeight, false, () => {
    // Line widths are in image units and the transform scales them, so a plain 1 would come out as thick as one whole screen pixel per unit of zoom.
    // Dividing by scale cancels that and gives a hairline at any zoom.
    context.lineWidth = 1 / viewScale
    context.strokeStyle = 'rgb(30 26 22 / 0.35)'

    for (const piece of pieces) drawPiece(context, piece, image, piece.col * gap, piece.row * gap)
  })
}

// Deliberately the naive version: one clip and one draw call per piece, on the main thread, every frame.
// Phase 3 moves this into a worker and bakes each piece once into an atlas, and Phase 5 is where the number that justifies all of that gets measured.
//
// dx and dy are the only thing that differ between drawing a piece as part of the exploded whole puzzle
// and drawing one piece alone in the isolated view: the whole puzzle offsets by the gap explosion, the
// isolated view offsets by the negative bbox corner so the piece lands at the content origin instead.
function drawPiece(ctx: CanvasRenderingContext2D, piece: PieceGeometry, source: ImageBitmap, dx: number, dy: number): void {
  ctx.save()
  ctx.translate(dx, dy)

  const first = piece.path[0]!
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  for (let i = 1; i < piece.path.length; i++) {
    const point = piece.path[i]!
    ctx.lineTo(point.x, point.y)
  }
  ctx.closePath()

  // A clip cannot be narrowed back out, only unwound by restore, hence the inner pair.
  ctx.save()
  ctx.clip()

  // The bbox is what makes this cheap. Without it every piece would redraw the whole source image and only keep the sliver inside the clip.
  const box = piece.bbox
  ctx.drawImage(source, box.x, box.y, box.width, box.height, box.x, box.y, box.width, box.height)
  ctx.restore()

  // The current path survives restore, since it is not part of the saved drawing state, so the outline is still here to stroke.
  ctx.stroke()
  ctx.restore()
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

// Zoom about a point rather than about the corner, so whatever is under the cursor stays under the cursor.
//
// The content coordinate under the cursor is pan + screenOffset / scale. Holding that fixed while the scale changes and solving for the new pan gives the line below.
// Zooming about the corner instead is the thing that makes a zoom feel broken: the piece you were looking at slides away as you go in.
function zoomAbout(screenX: number, screenY: number, factor: number): void {
  const target = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM)
  if (target === zoom) return

  const contentX = panX + screenX / viewScale
  const contentY = panY + screenY / viewScale

  // viewScale is still the old scale here, so the ratio is how much the scale is about to change by.
  const newScale = viewScale * (target / zoom)

  panX = contentX - screenX / newScale
  panY = contentY - screenY / newScale
  zoom = target

  draw()
}

// The player supplies the image in the real game, so the lab ships no assets and draws its own stand in.
// Deliberately busy, because a flat colour would hide a misaligned cut. The corner to corner diagonals are the giveaway: if the coordinate mapping is wrong they miss the corners.
// Sized like a real camera upload rather than like a thumbnail, so the default view exercises the downscale path.
// At 1600 by 1200 every band came out limitedBySource, which demonstrated the clamp and hid the normal case.
async function placeholderImage(): Promise<ImageBitmap> {
  const source = document.createElement('canvas')
  source.width = 4000
  source.height = 3000

  const ctx = context2d(source)

  const sky = ctx.createLinearGradient(0, 0, 0, source.height)
  sky.addColorStop(0, '#6d9dc5')
  sky.addColorStop(1, '#e8c9a0')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, source.width, source.height)

  // Seeded, so the stand in is the same picture every reload and a changed cut cannot be blamed on a changed image.
  const rng = makeRng(20260818, 'lab-placeholder')
  for (let i = 0; i < 40; i++) {
    ctx.beginPath()
    // Radii as a fraction of the width, so the picture keeps its proportions if the canvas size ever changes again.
    ctx.arc(rng.range(0, source.width), rng.range(0, source.height), rng.range(0.019, 0.088) * source.width, 0, Math.PI * 2)
    ctx.fillStyle = `hsl(${rng.range(0, 360).toFixed(0)} 55% 60% / 0.55)`
    ctx.fill()
  }

  ctx.strokeStyle = 'rgb(255 255 255 / 0.8)'
  ctx.lineWidth = 10
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(source.width, source.height)
  ctx.moveTo(source.width, 0)
  ctx.lineTo(0, source.height)
  ctx.stroke()

  return createImageBitmap(source)
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file === undefined) return

  // Same call Phase 3.1 will use for ingest, hardware accelerated and able to take a File directly.
  void createImageBitmap(file).then(setImage)
})

// A different band wants a different working resolution, so this one re-ingests rather than only rebuilding.
bandSelect.addEventListener('change', () => {
  selectedBandId = bandSelect.value
  void applyBand()
})

warpInput.addEventListener('input', rebuild)
tabSizeInput.addEventListener('input', rebuild)
tabVarianceInput.addEventListener('input', rebuild)

// Geometry does not change, only where the pieces are put, so this redraws without rebuilding.
// The hit paths do have to be rebuilt though, they bake the gap offset in.
gapInput.addEventListener('input', () => {
  gap = Number(gapInput.value)
  gapValue.textContent = `${gap}px`
  rebuildHitPaths()
  draw()
})
gapValue.textContent = `${gap}px`

// Wheel to zoom, drag to pan. Neither touches the geometry, so both only redraw.
canvas.addEventListener(
  'wheel',
  (event) => {
    // Without this the page scrolls instead, and the listener has to be non passive to be allowed to say so.
    event.preventDefault()

    const bounds = canvas.getBoundingClientRect()
    zoomAbout(event.clientX - bounds.left, event.clientY - bounds.top, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
  },
  { passive: false },
)

let dragging: { pointerId: number; x: number; y: number } | null = null

canvas.addEventListener('pointerdown', (event) => {
  dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }

  // Capture keeps the drag alive when the pointer leaves the canvas, which otherwise makes panning feel like it sticks at the edges.
  canvas.setPointerCapture(event.pointerId)
  canvas.classList.add('dragging')
})

canvas.addEventListener('pointermove', (event) => {
  if (dragging === null || event.pointerId !== dragging.pointerId) return

  // The drag is measured in screen pixels and pan is in content units, hence the division.
  panX -= (event.clientX - dragging.x) / viewScale
  panY -= (event.clientY - dragging.y) / viewScale
  dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }

  draw()
})

for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, () => {
    dragging = null
    canvas.classList.remove('dragging')
  })
}

// Double click a piece in the whole puzzle view to isolate it.
//
// isPointInPath does not take content coordinates: it takes raw canvas pixel buffer coordinates, and
// applies whatever transform the context currently has (the one the last draw() left set) to the path's
// own stored coordinates itself. So the click position only needs to become buffer pixels, the same
// CSS-to-buffer factor drawContent already uses, not content coordinates the way pan and zoom work.
canvas.addEventListener('dblclick', (event) => {
  if (isolatedIndex !== null) return

  const bounds = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const bufferX = (event.clientX - bounds.left) * dpr
  const bufferY = (event.clientY - bounds.top) * dpr

  const index = hitPaths.findIndex((path) => context.isPointInPath(path, bufferX, bufferY))
  if (index !== -1) enterIsolation(index)
})

backToPuzzleButton.addEventListener('click', exitIsolation)

// Colour only, geometry does not change, but a baked preview embeds the image pixels, so it has to be rebuilt too.
printInput.addEventListener('change', () => {
  updateBakePreview()
  draw()
})

bakePreviewInput.addEventListener('change', () => {
  updateBakePreview()
  draw()
})

resetViewButton.addEventListener('click', resetView)

bakeFullButton.addEventListener('click', () => {
  void bakeFullPuzzle()
})

closeAtlasButton.addEventListener('click', closeAtlasView)

function resetView(): void {
  zoom = 1
  panX = 0
  panY = 0
  draw()
}

window.addEventListener('resize', draw)

void placeholderImage().then(setImage)
