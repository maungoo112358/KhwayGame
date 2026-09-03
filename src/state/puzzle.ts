// PuzzleState: where every piece currently is and which cluster it belongs to. Structure of arrays
// typed arrays rather than one object per piece, per docs/architecture.md's low level techniques table.
// Pure data, no Pixi, no DOM. render/ subscribes and reflects, it never pokes these arrays directly,
// only through the commands in commands.ts.

import { PIECE_COUNT_BANDS, TARGET_PIECE_SIZE, type AssembledPiece, type PuzzleBuild, type Rng } from '../core'

export interface PuzzleState {
  readonly pieceCount: number
  // Current position per piece, index = piece id. Starts at each piece's solved position.
  readonly x: Float32Array
  readonly y: Float32Array
  // Union find parent pointer per piece, index = piece id. parent[id] === id means id is its own root.
  readonly parent: Int32Array
  // Actor id currently holding this piece's whole cluster, or -1. Not "the dragged piece", "pieces held
  // by actor X", so co-op never has to assume a single player. See docs/architecture.md's forward
  // compatibility notes.
  readonly heldBy: Int32Array
  // Read only reference into the build this state was created from. solved, neighbors, anchor and frame
  // all live here and never change once the puzzle is baked, so there is nothing to gain by copying them.
  readonly pieces: readonly AssembledPiece[]
}

export function createPuzzleState(build: PuzzleBuild): PuzzleState {
  const pieceCount = build.pieces.length
  const x = new Float32Array(pieceCount)
  const y = new Float32Array(pieceCount)
  const parent = new Int32Array(pieceCount)
  const heldBy = new Int32Array(pieceCount).fill(-1)

  for (const piece of build.pieces) {
    x[piece.id] = piece.solved.x
    y[piece.id] = piece.solved.y
    parent[piece.id] = piece.id
  }

  return { pieceCount, x, y, parent, heldBy, pieces: build.pieces }
}

// The table is sized once, from the biggest puzzle the game allows, never from whatever puzzle is
// actually open. A table that grows and shrinks with piece count means a small puzzle gets a table too
// cramped to have any real room to pan in, since the whole thing already fits on screen, see
// docs/status.md. Deriving the reference from PIECE_COUNT_BANDS rather than a hardcoded piece count
// means a future change to the bands (a bigger Large band, say) grows the table with it automatically,
// nothing here needs to change by hand.
const MAX_ALLOWED_PIECES = Math.max(...PIECE_COUNT_BANDS.map((band) => band.maxPieces))

// A piece's baked footprint is TARGET_PIECE_SIZE on a side by construction, core/ingest.ts derives the
// working resolution specifically to land there, so total working area at the biggest allowed puzzle is
// approximately piece count times that, regardless of whatever aspect ratio the uploaded image actually
// has. This is the reference the table is sized against, not any individual puzzle's own working area.
const REFERENCE_WORKING_AREA = MAX_ALLOWED_PIECES * TARGET_PIECE_SIZE * TARGET_PIECE_SIZE

// How many times the reference area (above) the table is. 10 means a table 10 times the area of the
// biggest puzzle the game allows, not 10 times whatever puzzle is actually open, so the table's physical
// size, and how much room there is to pan, stays the same across every piece count.
const TABLE_AREA_MULTIPLIER = 10

// Expands a working (solved) size into a scatter area sized to TABLE_AREA_MULTIPLIER times the reference
// working area (both above), uniformly on both axes so the aspect ratio the board fits to screen against
// does not change. Deliberately not sized off `working` itself, see the constants above for why the
// table is the same physical size regardless of how many pieces this particular puzzle actually has.
export function scatterBounds(working: { w: number; h: number }, referenceArea: number = REFERENCE_WORKING_AREA, multiplier: number = TABLE_AREA_MULTIPLIER): { w: number; h: number } {
  const scale = Math.sqrt((referenceArea * multiplier) / (working.w * working.h))
  return { w: working.w * scale, h: working.h * scale }
}

// Fisher-Yates over an arbitrary list of ids, not assumed to be 0..count-1, kept general rather than
// baked into scatterPieces itself.
function shuffledOrder(ids: readonly number[], rng: Rng): number[] {
  const order = ids.slice()
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng.float() * (i + 1))
    const swap = order[i]!
    order[i] = order[j]!
    order[j] = swap
  }
  return order
}

// A few real pixels of daylight between shelf-packed pieces, so touching is never mistaken for snapped.
const SHELF_GAP = 4

// The area a placement pass actually used, which is not always bounds: shelf packing (below) grows
// downward as far as it needs to and never shrinks itself to fit a target height, so the caller has to
// ask what really happened rather than assume its own request was met exactly. The camera has to be
// sized from this, not from bounds, or it will clip off pieces sitting below wherever bounds.h assumed
// everything would end.
export interface PlacementBounds {
  w: number
  h: number
}

// The actual placement algorithm, used by scatterPieces: classic shelf packing, not a uniform grid.
// Pieces are
// placed left to right using each piece's own real frame size, wrapping to a new row once a row is
// full. This is the second attempt at this function, the first used a grid of equal sized cells sized
// from ids.length and bounds alone, which implicitly assumed every piece is roughly the same size. Real
// baked pieces are not: tab overhang varies piece to piece, up to roughly 40% over nominal per
// docs/architecture.md, so a piece bigger than its assigned cell spilled into its neighbour's. That bug
// was invisible in every unit test here because the synthetic test fixture uses uniformly sized pieces,
// and was only found by checking real baked geometry at real scale, all 972 pieces, every pair, not a
// screenshot. Shelf packing makes no assumption about piece size at all, so this class of bug cannot
// recur: a piece only ever occupies its own real footprint plus SHELF_GAP, nothing else's. bounds.w
// caps how wide a row is allowed to grow, bounds.h is not enforced, rows simply keep stacking downward.
function placeInGrid(state: PuzzleState, ids: readonly number[], bounds: { w: number; h: number }, rng: Rng): PlacementBounds {
  if (ids.length === 0) return { w: 0, h: 0 }

  const order = shuffledOrder(ids, rng)

  let x = 0
  let y = 0
  let rowHeight = 0
  let usedWidth = 0

  for (const id of order) {
    const piece = state.pieces[id]!
    const w = piece.frame.width + SHELF_GAP
    const h = piece.frame.height + SHELF_GAP

    // Wrap to a new row once this piece would run past the right edge, unless it is the first piece on
    // an empty row, which always gets placed regardless of whether it alone overflows bounds.w.
    if (x > 0 && x + w > bounds.w) {
      x = 0
      y += rowHeight
      rowHeight = 0
    }

    state.x[id] = x
    state.y[id] = y
    usedWidth = Math.max(usedWidth, x + piece.frame.width)
    x += w
    rowHeight = Math.max(rowHeight, h)
  }

  return { w: usedWidth, h: y + rowHeight }
}

// Scatters every piece to a position within bounds, in place. Kept separate from creation because a
// resumed save skips this entirely, positions come from the save instead. Returns the area actually
// used, see PlacementBounds, the caller's camera must be sized from this, not from bounds.
export function scatterPieces(state: PuzzleState, bounds: { w: number; h: number }, rng: Rng): PlacementBounds {
  const allIds = Array.from({ length: state.pieceCount }, (_, i) => i)
  return placeInGrid(state, allIds, bounds, rng)
}

// Shifts every piece so the shelf-packed block scatterPieces produced sits centered within tableBounds,
// instead of pinned to the top-left corner where placeInGrid always starts. tableBounds is usually far
// bigger than used, see the table sizing constants above, so a corner-pinned block leaves the player's
// pieces stranded in one corner of a much larger table: zoom out past that block and zoom back in
// anywhere else, and every piece is still up in that corner, off screen. Centering means any zoom-in
// from the fully-zoomed-out view lands close to where the pieces actually are. tableBounds is always at
// least as big as used on both axes (it is defined as the max of the two), so both offsets are >= 0.
//
// topClearance shifts the vertical anchor up from dead-center by that many table-space units, still
// clamped to >= 0 so it can never push the block above the table's own top edge. Table-space, not
// screen-space, on purpose: this module knows nothing about a camera or a screen, see the architecture
// boundary in CLAUDE.md, so the caller (which does) converts whatever it needs cleared into a plain
// number before calling in.
export function centerPlacement(state: PuzzleState, tableBounds: { w: number; h: number }, used: PlacementBounds, topClearance: number = 0): void {
  const offsetX = (tableBounds.w - used.w) / 2
  const offsetY = Math.max(0, (tableBounds.h - used.h) / 2 - topClearance)
  for (let id = 0; id < state.pieceCount; id++) {
    state.x[id] = state.x[id]! + offsetX
    state.y[id] = state.y[id]! + offsetY
  }
}

// True once every piece has merged into one cluster, whatever id happens to be its root. The win
// condition: nothing here cares which piece that is, only that there is exactly one.
export function isSolved(state: PuzzleState, clusters: { find(id: number): number }): boolean {
  if (state.pieceCount === 0) return false
  const root = clusters.find(0)
  for (let id = 1; id < state.pieceCount; id++) {
    if (clusters.find(id) !== root) return false
  }
  return true
}
