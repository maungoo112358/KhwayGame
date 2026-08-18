import { buildLattice, vertexAt, gridOptions, type GridOption, type Lattice } from '../core/lattice'
import { makeRng } from '../core/rng'

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
const readout = need<HTMLSpanElement>('#readout')

// A function rather than an inline null check, because narrowing a module level const does not follow into function bodies.
function context2d(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = target.getContext('2d')
  if (ctx === null) throw new Error('this browser has no 2d canvas context')
  return ctx
}

const context = context2d(canvas)

let image: ImageBitmap | null = null
let lattice: Lattice | null = null
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

  lattice = buildLattice(chosen.grid)

  // The count is on the dropdown itself, so this carries only what the dropdown cannot.
  readout.textContent = `cells ${chosen.grid.cellWidth.toFixed(1)} by ${chosen.grid.cellHeight.toFixed(1)} image px, source ${image.width} by ${image.height}`

  draw()
}

function draw(): void {
  if (image === null || lattice === null) return

  // Fit inside the width the page gives us and the height left below the controls, and never enlarge past 1:1.
  // Reading clientWidth of the parent rather than of the canvas avoids a feedback loop, since a block div's width does not depend on how wide its children are.
  const widthBudget = output.clientWidth
  const heightBudget = Math.max(240, window.innerHeight - output.getBoundingClientRect().top - 40)
  const scale = Math.min(widthBudget / image.width, heightBudget / image.height, 1)

  // Two different sizes on purpose. The style is in CSS pixels, the attributes are the real pixel buffer, and on a 2x display those differ by the device pixel ratio.
  // Skipping this is what makes canvas lines look soft on a high dpi screen.
  const dpr = window.devicePixelRatio || 1
  canvas.style.width = `${image.width * scale}px`
  canvas.style.height = `${image.height * scale}px`
  canvas.width = Math.round(image.width * scale * dpr)
  canvas.height = Math.round(image.height * scale * dpr)

  // Assigning canvas.width resets the whole context state, transform included, so this has to come after.
  context.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0)
  context.drawImage(image, 0, 0)

  strokeLattice(context, lattice, scale)
}

function strokeLattice(ctx: CanvasRenderingContext2D, grid: Lattice, scale: number): void {
  // Line widths are in image units and the transform scales them, so a plain 1 would come out as thick as one whole screen pixel per unit of zoom.
  // Dividing by scale cancels that and gives a hairline at any zoom.
  const hairline = 1 / scale

  // Polylines through the vertices rather than a rectangle per cell.
  // They are straight today because the lattice is unwarped, and they will bend at every vertex on their own once the warp lands in 2.6.
  ctx.beginPath()
  for (let row = 0; row <= grid.rows; row++) {
    for (let col = 0; col <= grid.cols; col++) {
      const point = vertexAt(grid, col, row)
      if (col === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    }
  }
  for (let col = 0; col <= grid.cols; col++) {
    for (let row = 0; row <= grid.rows; row++) {
      const point = vertexAt(grid, col, row)
      if (row === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    }
  }
  ctx.strokeStyle = 'rgb(40 36 32 / 0.5)'
  ctx.lineWidth = hairline
  ctx.stroke()

  // The outer ring, walked vertex by vertex rather than drawn as a rectangle, so it shows where the lattice actually is instead of where we assume it is.
  // This is the gate: it must hug the photo exactly, with no gap and no overhang.
  ctx.beginPath()
  for (let col = 0; col <= grid.cols; col++) traceTo(ctx, grid, col, 0)
  for (let row = 1; row <= grid.rows; row++) traceTo(ctx, grid, grid.cols, row)
  for (let col = grid.cols - 1; col >= 0; col--) traceTo(ctx, grid, col, grid.rows)
  for (let row = grid.rows - 1; row >= 0; row--) traceTo(ctx, grid, 0, row)
  ctx.closePath()
  ctx.strokeStyle = '#b4432c'
  ctx.lineWidth = hairline * 2
  ctx.stroke()
}

function traceTo(ctx: CanvasRenderingContext2D, grid: Lattice, col: number, row: number): void {
  const point = vertexAt(grid, col, row)
  if (col === 0 && row === 0) ctx.moveTo(point.x, point.y)
  else ctx.lineTo(point.x, point.y)
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

window.addEventListener('resize', draw)

void placeholderImage().then(setImage)
