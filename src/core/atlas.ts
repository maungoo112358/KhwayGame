// Packing baked piece bitmaps into a small number of large texture sheets, so the renderer reads from
// one or two shared textures instead of one per piece. See "Memory budget" in docs/ARCHITECTURE.md for
// why: draw call batching needs a shared texture, and VRAM overhead is per allocation, not just per pixel.
//
// Pure arithmetic on rectangle sizes, no OffscreenCanvas, no ImageBitmap. The actual compositing, drawing
// each baked piece into its assigned sheet, is a later step. This module only decides where things go.
//
// MaxRects, best area fit, no rotation. Rotation would need PieceDef.frame to carry an orientation and
// the renderer to undo it per sprite, real complexity, for a few percent efficiency, and it cuts against
// pieces never rotating anywhere else in the game.

export interface AtlasRect {
  id: number
  width: number
  height: number
}

export interface AtlasPlacement {
  id: number
  atlas: number
  x: number
  y: number
}

export interface AtlasResult {
  sheetSize: number
  sheetCount: number
  placements: AtlasPlacement[]
  // Total piece area, gutter excluded, divided by total sheet area. What docs/ARCHITECTURE.md's
  // "~85% packing efficiency" figure means, and the number the two sheet gate depends on.
  efficiency: number
}

export interface AtlasOptions {
  // The largest texture size assumed portable across GPUs. See "Memory budget" in docs/ARCHITECTURE.md.
  sheetSize?: number
  // Transparent pixels reserved between neighbouring pieces, so GPU texture filtering on a scaled sprite
  // cannot bleed a neighbour's edge in. Not the rim overhang, that is already baked into each piece's own
  // bitmap size by bakePiece.
  gutter?: number
}

const DEFAULT_SHEET_SIZE = 4096
const DEFAULT_GUTTER = 2

interface FreeRect {
  x: number
  y: number
  width: number
  height: number
}

function intersects(a: FreeRect, b: FreeRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function contains(a: FreeRect, b: FreeRect): boolean {
  return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height
}

// The used rectangle can overlap several free rectangles at once, since free rectangles are allowed to
// overlap each other, that is what "Max Rects" means. Each overlapping free rectangle is replaced by up
// to four smaller ones: whatever is left of it to the left, right, above and below the used rectangle.
function splitFreeRect(free: FreeRect, used: FreeRect): FreeRect[] {
  const pieces: FreeRect[] = []

  if (used.x > free.x) {
    pieces.push({ x: free.x, y: free.y, width: used.x - free.x, height: free.height })
  }
  if (used.x + used.width < free.x + free.width) {
    pieces.push({ x: used.x + used.width, y: free.y, width: free.x + free.width - (used.x + used.width), height: free.height })
  }
  if (used.y > free.y) {
    pieces.push({ x: free.x, y: free.y, width: free.width, height: used.y - free.y })
  }
  if (used.y + used.height < free.y + free.height) {
    pieces.push({ x: free.x, y: used.y + used.height, width: free.width, height: free.y + free.height - (used.y + used.height) })
  }

  return pieces
}

// Without this the free list only grows: every split adds up to four rectangles, and most of them end up
// sitting entirely inside some other free rectangle. Deduplicating first means two distinct survivors can
// never contain each other, only true duplicates would, so a plain one way containment check is safe.
function pruneFreeRects(rects: FreeRect[]): FreeRect[] {
  const seen = new Set<string>()
  const distinct: FreeRect[] = []

  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
    if (seen.has(key)) continue
    seen.add(key)
    distinct.push(rect)
  }

  return distinct.filter((rect, index) => !distinct.some((other, otherIndex) => index !== otherIndex && contains(other, rect)))
}

interface PaddedRect {
  id: number
  width: number
  height: number
}

interface SheetPlacement {
  id: number
  x: number
  y: number
}

// One sheet's worth of packing. Whatever does not fit comes back in `remaining` for the next sheet.
// Does not know which sheet it is, packAtlas fills that in once packing this sheet is done.
function packSheet(rects: PaddedRect[], sheetSize: number): { placements: SheetPlacement[]; remaining: PaddedRect[] } {
  let freeRects: FreeRect[] = [{ x: 0, y: 0, width: sheetSize, height: sheetSize }]
  const placements: SheetPlacement[] = []
  const remaining: PaddedRect[] = []

  for (const rect of rects) {
    // Best area fit: among every free rectangle the piece fits inside, pick the one that wastes the least leftover area, rather than just the first one found.
    let bestIndex = -1
    let bestLeftover = Infinity

    for (let i = 0; i < freeRects.length; i++) {
      const free = freeRects[i]!
      if (rect.width > free.width || rect.height > free.height) continue

      const leftover = free.width * free.height - rect.width * rect.height
      if (leftover < bestLeftover) {
        bestLeftover = leftover
        bestIndex = i
      }
    }

    if (bestIndex === -1) {
      remaining.push(rect)
      continue
    }

    const free = freeRects[bestIndex]!
    placements.push({ id: rect.id, x: free.x, y: free.y })

    const used: FreeRect = { x: free.x, y: free.y, width: rect.width, height: rect.height }
    const next: FreeRect[] = []
    for (const candidate of freeRects) {
      if (intersects(candidate, used)) {
        next.push(...splitFreeRect(candidate, used))
      } else {
        next.push(candidate)
      }
    }
    freeRects = pruneFreeRects(next)
  }

  return { placements, remaining }
}

export function packAtlas(rects: AtlasRect[], options: AtlasOptions = {}): AtlasResult {
  const sheetSize = options.sheetSize ?? DEFAULT_SHEET_SIZE
  const gutter = options.gutter ?? DEFAULT_GUTTER

  for (const rect of rects) {
    if (rect.width + gutter > sheetSize || rect.height + gutter > sheetSize) {
      throw new Error(`piece ${rect.id} is ${rect.width} by ${rect.height}, too large for a ${sheetSize} atlas`)
    }
  }

  const byId = new Map(rects.map((rect) => [rect.id, rect]))

  // Tallest first. An irregular set of rectangles packs noticeably tighter placed in size order than in
  // whatever order pieces happen to come in, since the biggest, hardest to place pieces get first pick
  // of the empty sheet instead of being squeezed into whatever is left.
  let remaining: PaddedRect[] = rects
    .map((rect) => ({ id: rect.id, width: rect.width + gutter, height: rect.height + gutter }))
    .sort((a, b) => b.height - a.height)

  const placements: AtlasPlacement[] = []
  let atlas = 0
  let usedArea = 0

  while (remaining.length > 0) {
    const before = remaining.length
    const sheet = packSheet(remaining, sheetSize)

    for (const placement of sheet.placements) {
      placements.push({ id: placement.id, atlas, x: placement.x, y: placement.y })
      usedArea += byId.get(placement.id)!.width * byId.get(placement.id)!.height
    }

    atlas += 1
    remaining = sheet.remaining

    // The upfront size check above guarantees every rectangle fits an empty sheet on its own, so a sheet
    // that placed nothing would mean that guarantee was violated, not a normal "sheet is full" outcome.
    if (remaining.length >= before) {
      throw new Error('atlas packer made no progress on a sheet, this should be unreachable')
    }
  }

  return {
    sheetSize,
    sheetCount: atlas,
    placements,
    efficiency: usedArea / (atlas * sheetSize * sheetSize),
  }
}
