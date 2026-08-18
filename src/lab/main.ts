import { createWarpedGridGeometry, gridOptions, makeRng, type GridOption, type PieceGeometry } from '../core'

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
const readout = need<HTMLSpanElement>('#readout')

// A function rather than an inline null check, because narrowing a module level const does not follow into function bodies.
function context2d(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = target.getContext('2d')
  if (ctx === null) throw new Error('this browser has no 2d canvas context')
  return ctx
}

const context = context2d(canvas)

// How far apart to push neighbouring pieces, in image pixels, so the cut is visible.
// At zero the pieces tile back into the original image exactly, which is the property lattice.test.ts proves by area.
const PIECE_GAP = 5

// Fixed, so the same image always cuts the same way and a changed picture is never the seed's fault.
const SEED = 20260818

let image: ImageBitmap | null = null
let pieces: PieceGeometry[] = []
let columns = 0
let rows = 0
let options: GridOption[] = []

// Which band the player picked, kept across image changes so choosing a new photo does not silently reset the size.
let selectedBandId = 'medium'

// A new image means new options, because the aspect ratio drives cols and rows and therefore the true piece count.
function setImage(bitmap: ImageBitmap): void {
  image = bitmap
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

  rebuild()
}

function rebuild(): void {
  if (image === null) return

  const chosen = options.find(({ band }) => band.id === selectedBandId)
  if (chosen === undefined) return

  // The slider is in whole percent, warpLattice wants a fraction, and its ceiling of 40 matches MAX_AMPLITUDE.
  const amplitude = Number(warpInput.value) / 100
  warpValue.textContent = `${warpInput.value}%`

  // One call. The lab does not know there is a lattice, a noise field or a bezier behind this, which is the entire point of the seam.
  pieces = createWarpedGridGeometry({ grid: chosen.grid, seed: SEED, warp: { amplitude } }).pieces()
  columns = chosen.grid.cols
  rows = chosen.grid.rows

  // The count is on the dropdown itself, so this carries only what the dropdown cannot.
  readout.textContent = `cells ${chosen.grid.cellWidth.toFixed(1)} by ${chosen.grid.cellHeight.toFixed(1)} image px, source ${image.width} by ${image.height}`

  draw()
}

function draw(): void {
  if (image === null || pieces.length === 0) return

  // Pushing pieces apart makes the drawing wider than the image, so the fit is computed against the exploded size rather than the source.
  const contentWidth = image.width + (columns - 1) * PIECE_GAP
  const contentHeight = image.height + (rows - 1) * PIECE_GAP

  // Fit inside the width the page gives us and the height left below the controls, and never enlarge past 1:1.
  // Reading clientWidth of the parent rather than of the canvas avoids a feedback loop, since a block div's width does not depend on how wide its children are.
  const widthBudget = output.clientWidth
  const heightBudget = Math.max(240, window.innerHeight - output.getBoundingClientRect().top - 40)
  const scale = Math.min(widthBudget / contentWidth, heightBudget / contentHeight, 1)

  // Two different sizes on purpose. The style is in CSS pixels, the attributes are the real pixel buffer, and on a 2x display those differ by the device pixel ratio.
  // Skipping this is what makes canvas lines look soft on a high dpi screen.
  const dpr = window.devicePixelRatio || 1
  canvas.style.width = `${contentWidth * scale}px`
  canvas.style.height = `${contentHeight * scale}px`
  canvas.width = Math.round(contentWidth * scale * dpr)
  canvas.height = Math.round(contentHeight * scale * dpr)

  // Assigning canvas.width resets the whole context state, transform included, so this has to come after.
  context.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0)

  // Line widths are in image units and the transform scales them, so a plain 1 would come out as thick as one whole screen pixel per unit of zoom.
  // Dividing by scale cancels that and gives a hairline at any zoom.
  context.lineWidth = 1 / scale
  context.strokeStyle = 'rgb(30 26 22 / 0.35)'

  for (const piece of pieces) drawPiece(context, piece, image)
}

// Deliberately the naive version: one clip and one draw call per piece, on the main thread, every frame.
// Phase 3 moves this into a worker and bakes each piece once into an atlas, and Phase 5 is where the number that justifies all of that gets measured.
function drawPiece(ctx: CanvasRenderingContext2D, piece: PieceGeometry, source: ImageBitmap): void {
  ctx.save()
  ctx.translate(piece.col * PIECE_GAP, piece.row * PIECE_GAP)

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

// The player supplies the image in the real game, so the lab ships no assets and draws its own stand in.
// Deliberately busy, because a flat colour would hide a misaligned cut. The corner to corner diagonals are the giveaway: if the coordinate mapping is wrong they miss the corners.
async function placeholderImage(): Promise<ImageBitmap> {
  const source = document.createElement('canvas')
  source.width = 1600
  source.height = 1200

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
    ctx.arc(rng.range(0, source.width), rng.range(0, source.height), rng.range(30, 140), 0, Math.PI * 2)
    ctx.fillStyle = `hsl(${rng.range(0, 360).toFixed(0)} 55% 60% / 0.55)`
    ctx.fill()
  }

  ctx.strokeStyle = 'rgb(255 255 255 / 0.8)'
  ctx.lineWidth = 4
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

bandSelect.addEventListener('change', () => {
  selectedBandId = bandSelect.value
  rebuild()
})

warpInput.addEventListener('input', rebuild)

window.addEventListener('resize', draw)

void placeholderImage().then(setImage)
