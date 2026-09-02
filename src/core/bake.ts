// Turning one piece of geometry into one piece of cardboard: a raw board rim showing through behind the
// top face, then the clipped photo, then a die cut crush line. See "Cardboard anatomy" in
// docs/ARCHITECTURE.md for the recipe this follows.
//
// Shaped like printTreat: opens its own OffscreenCanvas, draws, hands back a transferred ImageBitmap.
// Worker safe by construction, the same way ingest and print treatment were before they had to move.
//
// The rim is lit from the piece's own top left corner to its bottom right, the same fixed light
// direction as the rest of the game, using a canvas linear gradient across the piece's bounding box
// rather than computing an outward normal at every point of an irregular, warped, tabbed outline.
//
// The crush stroke's upper left highlight from docs/ARCHITECTURE.md is deliberately not implemented
// here. It was built, tested with a real photo, and dropped: the same gradient technique that lights the
// rim well does not generalise across piece shapes for a thin highlight stroke. A border piece's long
// straight edges sit close to the lit corner along their whole length and the highlight swallowed real
// image content, while an interior piece's tab covered outline stays far enough from the corner that the
// same settings showed nothing at all. No single width or reach served both. See D21 in
// docs/DECISIONS.md for the full account and the condition for revisiting it.

import type { PieceGeometry } from "./geometry";
import type { Point } from "./lattice";

export interface CardboardOptions {
  // Raw board colour on the side facing the light.
  rimColorLight?: string;
  // Raw board colour on the side facing away from the light.
  rimColorDark?: string;
  // How far down and right the rim is offset from the top face. This offset is what reads as thickness.
  rimOffset?: number;
  // Width of the die cut crush stroke, traced along the same path the clip used.
  crushWidth?: number;
  // Alpha of the crush stroke. Present on every edge, regardless of which way it faces.
  crushAlpha?: number;
}

export interface AlphaMask {
  bits: Uint8Array;
  w: number;
  h: number;
}

const DEFAULT_RIM_COLOR_LIGHT = "#E8D9BE";
const DEFAULT_RIM_COLOR_DARK = "#7C6448";
const DEFAULT_RIM_OFFSET = 6;
const DEFAULT_CRUSH_WIDTH = 2;
const DEFAULT_CRUSH_ALPHA = 0.5;
export const ALPHA_MASK_SCALE = 0.5;

function outlinePath(points: Point[]): Path2D {
  const path = new Path2D();
  const first = points[0]!;
  path.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    path.lineTo(point.x, point.y);
  }
  path.closePath();
  return path;
}

// Pieces whose shared edge with `piece` should not show `piece`'s own rim, because they are already
// connected. Only ever the pieces actually joined right now, not every grid neighbour, a loose piece
// still wants its full rim on every side.
export function bakePiece(piece: PieceGeometry, image: ImageBitmap, options: CardboardOptions = {}, connectedNeighbors: readonly PieceGeometry[] = [], ): ImageBitmap {
  const rimColorLight = options.rimColorLight ?? DEFAULT_RIM_COLOR_LIGHT;
  const rimColorDark = options.rimColorDark ?? DEFAULT_RIM_COLOR_DARK;
  const rimOffset = options.rimOffset ?? DEFAULT_RIM_OFFSET;
  const crushWidth = options.crushWidth ?? DEFAULT_CRUSH_WIDTH;
  const crushAlpha = options.crushAlpha ?? DEFAULT_CRUSH_ALPHA;

  // Only down and right need extra room: the rim is offset that way, and the top face and crush stroke both sit exactly on the piece's own bbox.
  const box = piece.bbox;
  const canvas = new OffscreenCanvas( Math.ceil(box.width + rimOffset), Math.ceil(box.height + rimOffset));
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("this environment has no 2d canvas context");
    
  // piece.path is in image space. Shifting the origin to the box corner is what lands it inside this
  // small canvas instead of off in the middle of the source photo.
  ctx.translate(-box.x, -box.y);
  const outline = outlinePath(piece.path);

  // Layer 1: the rim. Filled first so the face drawn next covers most of it, offset down and right so a
  // sliver keeps showing on exactly those two sides, never the top or left. The gradient runs corner to
  // corner of the whole photo, not this piece's own small box: every piece is a window onto one shared
  // light field, at the same absolute image coordinates the translate above already put this canvas in
  // terms of, so two neighbouring pieces sample the same continuous gradient at the seam between them
  // instead of each restarting light-to-dark from its own corner. Using the piece's own box here was
  // the earlier version, and it read as a patchwork of separately lit pieces rather than one photo lit
  // from a single direction, worst along the puzzle's outer border where every piece still shows a rim.
  const rimGradient = ctx.createLinearGradient(0, 0, image.width, image.height);
  rimGradient.addColorStop(0, rimColorLight);
  rimGradient.addColorStop(1, rimColorDark);

  ctx.save();
  ctx.translate(rimOffset, rimOffset);
  ctx.fillStyle = rimGradient;
  ctx.fill(outline);
  ctx.restore();

  // A connected neighbour's own outline erases whatever rim just got painted underneath it: once two
  // pieces are actually joined, the raw board colour peeking out past the tab is what reads as a "gap"
  // at the seam, real cardboard flush against another piece does not show its own edge there. Erasing
  // with the neighbour's true, unshifted outline (not this piece's) is what makes the cut visually
  // reappear as one continuous surface rather than the rim's sliver. destination-out removes whatever is
  // already drawn wherever this fill has alpha, it does not care what colour the fill itself is.
  if (connectedNeighbors.length > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const neighbor of connectedNeighbors) {
      ctx.fill(outlinePath(neighbor.path));
    }
    ctx.restore();
  }

  // Layer 2: the top face. Same clip-then-drawImage the lab's naive drawPiece already does, just with
  // the treated image rather than raw pixels.
  ctx.save();
  ctx.clip(outline);
  ctx.drawImage(image,box.x,box.y,box.width,box.height,box.x,box.y,box.width,box.height,);
  ctx.restore();

  // Layer 3: the die cut crush, traced along the same outline the clip used, present all the way round.
  ctx.lineWidth = crushWidth;
  ctx.strokeStyle = `rgb(0 0 0 / ${crushAlpha})`;
  ctx.stroke(outline);

  return canvas.transferToImageBitmap();
}

export function pieceDominantColor(piece: PieceGeometry,  image: ImageBitmap): number {
  const box = piece.bbox;
  const canvas = new OffscreenCanvas( Math.ceil(box.width), Math.ceil(box.height),  );

  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('this environment has no 2d canvas context');

  ctx.translate(-box.x, -box.y);
  const outline = outlinePath(piece.path);

  ctx.save();
  ctx.clip(outline);
  ctx.drawImage(image,box.x,box.y,box.width,box.height,box.x,box.y,box.width,box.height,);
  ctx.restore();

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  let red: number = 0;
  let green: number = 0;
  let blue: number = 0;
  let count: number = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const a = pixels[i + 3]!;

    if (a == 0) continue;
    red += r;
    green += g;
    blue += b;
    count++;
  }
  red = red / count;
  green = green / count;
  blue = blue / count;

  return (Math.round(red) << 16) | (Math.round(green) << 8) | Math.round(blue);
}

export function pieceAlphaMask(piece: PieceGeometry): AlphaMask {
  const box = piece.bbox;
  const maskWidth = Math.ceil(box.width * ALPHA_MASK_SCALE);
  const maskHeight = Math.ceil(box.height * ALPHA_MASK_SCALE);
  const canvas = new OffscreenCanvas(maskWidth, maskHeight);
  const ctx = canvas.getContext("2d");
  if (ctx === null)throw new Error("this environment has no 2d canvas context");

  ctx.scale(ALPHA_MASK_SCALE, ALPHA_MASK_SCALE);
  ctx.translate(-box.x, -box.y);

  const outline = outlinePath(piece.path);

  ctx.save();
  ctx.fill(outline);
  ctx.restore();

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const bits: Uint8Array = new Uint8Array(Math.ceil((maskWidth * maskHeight) / 8));

  for(let i = 0; i<pixels.length; i+=4){
    const a = pixels[i + 3]!;

    if(a === 0) continue;
  
   const pixelIndex = i/4;
   let byteIndex :number = pixelIndex >> 3
   let bitIndex : number = pixelIndex & 7;
   bits[byteIndex]! |= (1 << bitIndex)
  }
  return {bits, w : maskWidth, h : maskHeight};

}
