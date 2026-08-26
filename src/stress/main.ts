import { makeRng } from "../core"

// A function rather than an inline null check, because narrowing a module level const does not follow into function bodies.
function context2d(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = target.getContext('2d')
  if (ctx === null) throw new Error('this browser has no 2d canvas context')
  return ctx
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