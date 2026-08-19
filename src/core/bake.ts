// Turning one piece of geometry into one piece of cardboard: a raw board rim showing through behind the
// top face, then the clipped photo, then a die cut crush line. See "Cardboard anatomy" in
// docs/ARCHITECTURE.md for the recipe this follows.
//
// Shaped like printTreat: opens its own OffscreenCanvas, draws, hands back a transferred ImageBitmap.
// Worker safe by construction, the same way ingest and print treatment were before they had to move.
//
// Both the rim and the crush stroke are lit from the piece's own top left corner to its bottom right,
// the same fixed light direction as the rest of the game, using a canvas linear gradient across the
// piece's bounding box rather than computing an outward normal at every point of an irregular, warped,
// tabbed outline. A gradient does not know or care which way an edge is actually facing, it just
// answers "how far toward the lit corner is this pixel," which is enough to read as directional light
// without the geometry cost, and its softness suits the game's overcast, no-hard-shadows art direction
// better than a precise per-edge highlight would.
//
// The colours below are pushed well past docs/ART-DIRECTION.md's real numbers on purpose, so the effect
// is unambiguous while the mechanism itself is being judged. Softening them back down to the cozy,
// subtle version is a separate, later pass once the technique is confirmed to read as depth at all.

import type { PieceGeometry } from './geometry'
import type { Point } from './lattice'

export interface CardboardOptions {
  // Raw board colour on the side facing the light.
  rimColorLight?: string
  // Raw board colour on the side facing away from the light.
  rimColorDark?: string
  // How far down and right the rim is offset from the top face. This offset is what reads as thickness.
  rimOffset?: number
  // Width of the die cut crush stroke, traced along the same path the clip used.
  crushWidth?: number
  // Alpha of the crush stroke. Present on every edge, regardless of which way it faces.
  crushAlpha?: number
  // Width of the highlight stroke layered on top of the crush stroke, on the lit side only.
  highlightWidth?: number
  // Alpha of the highlight at its brightest, fading to zero by the shadowed corner.
  highlightAlpha?: number
}

const DEFAULT_RIM_COLOR_LIGHT = '#E8D9BE'
const DEFAULT_RIM_COLOR_DARK = '#7C6448'
const DEFAULT_RIM_OFFSET = 6
const DEFAULT_CRUSH_WIDTH = 2
const DEFAULT_CRUSH_ALPHA = 0.5
const DEFAULT_HIGHLIGHT_WIDTH = 2.5
const DEFAULT_HIGHLIGHT_ALPHA = 0.95

function outlinePath(points: Point[]): Path2D {
  const path = new Path2D()
  const first = points[0]!
  path.moveTo(first.x, first.y)
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!
    path.lineTo(point.x, point.y)
  }
  path.closePath()
  return path
}

export function bakePiece(piece: PieceGeometry, image: ImageBitmap, options: CardboardOptions = {}): ImageBitmap {
  const rimColorLight = options.rimColorLight ?? DEFAULT_RIM_COLOR_LIGHT
  const rimColorDark = options.rimColorDark ?? DEFAULT_RIM_COLOR_DARK
  const rimOffset = options.rimOffset ?? DEFAULT_RIM_OFFSET
  const crushWidth = options.crushWidth ?? DEFAULT_CRUSH_WIDTH
  const crushAlpha = options.crushAlpha ?? DEFAULT_CRUSH_ALPHA
  const highlightWidth = options.highlightWidth ?? DEFAULT_HIGHLIGHT_WIDTH
  const highlightAlpha = options.highlightAlpha ?? DEFAULT_HIGHLIGHT_ALPHA

  // Only down and right need extra room: the rim is offset that way, and the top face and crush stroke
  // both sit exactly on the piece's own bbox.
  const box = piece.bbox
  const canvas = new OffscreenCanvas(Math.ceil(box.width + rimOffset), Math.ceil(box.height + rimOffset))
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('this environment has no 2d canvas context')

  // piece.path is in image space. Shifting the origin to the box corner is what lands it inside this
  // small canvas instead of off in the middle of the source photo.
  ctx.translate(-box.x, -box.y)
  const outline = outlinePath(piece.path)

  // Layer 1: the rim. Filled first so the face drawn next covers most of it, offset down and right so a
  // sliver keeps showing on exactly those two sides, never the top or left. The gradient runs corner to
  // corner of the piece's own box, so it is lighter on the side facing the light regardless of shape.
  const rimGradient = ctx.createLinearGradient(box.x, box.y, box.x + box.width, box.y + box.height)
  rimGradient.addColorStop(0, rimColorLight)
  rimGradient.addColorStop(1, rimColorDark)

  ctx.save()
  ctx.translate(rimOffset, rimOffset)
  ctx.fillStyle = rimGradient
  ctx.fill(outline)
  ctx.restore()

  // Layer 2: the top face. Same clip-then-drawImage the lab's naive drawPiece already does, just with
  // the treated image rather than raw pixels.
  ctx.save()
  ctx.clip(outline)
  ctx.drawImage(image, box.x, box.y, box.width, box.height, box.x, box.y, box.width, box.height)
  ctx.restore()

  // Layer 3: the die cut crush, traced along the same outline the clip used, present all the way round.
  ctx.lineWidth = crushWidth
  ctx.strokeStyle = `rgb(0 0 0 / ${crushAlpha})`
  ctx.stroke(outline)

  // Layer 4: the highlight, a second stroke on top that only brightens the lit corner. The gradient fades
  // to fully transparent by the midpoint, so the shadowed corner is untouched and still shows the crush.
  const highlightGradient = ctx.createLinearGradient(box.x, box.y, box.x + box.width, box.y + box.height)
  highlightGradient.addColorStop(0, `rgb(255 255 255 / ${highlightAlpha})`)
  highlightGradient.addColorStop(0.45, 'rgb(255 255 255 / 0)')
  highlightGradient.addColorStop(1, 'rgb(255 255 255 / 0)')

  ctx.lineWidth = highlightWidth
  ctx.strokeStyle = highlightGradient
  ctx.stroke(outline)

  return canvas.transferToImageBitmap()
}
