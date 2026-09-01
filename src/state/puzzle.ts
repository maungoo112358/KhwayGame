// PuzzleState: where every piece currently is and which cluster it belongs to. Structure of arrays
// typed arrays rather than one object per piece, per docs/architecture.md's low level techniques table.
// Pure data, no Pixi, no DOM. render/ subscribes and reflects, it never pokes these arrays directly,
// only through the commands in commands.ts.

import type { AssembledPiece, PuzzleBuild, Rng } from '../core'

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

// How much more room a scattered layout gets than the solved layout's own footprint. Solved pieces tile
// edge to edge with zero gaps, so scattering into that exact same area, at any real piece count, reliably
// crams pieces on top of each other, this is not a tuning nicety, it is the actual cause of a real bug
// found by hand: a scattered board where most pieces sat hidden under other pieces. 30% target coverage
// leaves visible gaps between pieces without making the table absurdly large to pan across.
const SCATTER_DENSITY = 0.3

// Expands a working (solved) size into a scatter area sized to hit SCATTER_DENSITY, uniformly on both
// axes so the aspect ratio the board fits to screen against does not change.
export function scatterBounds(working: { w: number; h: number }, density: number = SCATTER_DENSITY): { w: number; h: number } {
  const scale = Math.sqrt(1 / density)
  return { w: working.w * scale, h: working.h * scale }
}

// Fisher-Yates over an arbitrary list of ids, not assumed to be 0..count-1: scatterWithTestCluster
// below places only a small subset of pieces this way, not every piece in state.
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

// The actual placement algorithm, shared by scatterPieces (every piece) and scatterWithTestCluster
// (just its small patch, into its own small box): classic shelf packing, not a uniform grid. Pieces are
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

// Walks real neighbour relationships breadth first from startId until size pieces are collected (or
// there are no more to reach, on a tiny puzzle). Used by scatterWithTestCluster to guarantee the pieces
// it isolates actually interlock with each other, not just a random, possibly disconnected handful.
function connectedPatch(state: PuzzleState, size: number, startId: number = 0): number[] {
  const visited = new Set<number>([startId])
  const queue: number[] = [startId]

  while (queue.length > 0 && visited.size < size) {
    const id = queue.shift()!
    for (const neighborId of state.pieces[id]!.neighbors) {
      if (neighborId === null || visited.has(neighborId) || visited.size >= size) continue
      visited.add(neighborId)
      queue.push(neighborId)
    }
  }

  return Array.from(visited)
}

// A standing debug aid, not a real gameplay mode: scatters everything normally, then pulls a small
// patch of real, mutually adjacent pieces into a tight box in the top left corner, close enough to
// reach without hunting through a full scatter of hundreds of pieces, but still not already touching,
// so a real drag is still what proves the snap. See docs/status.md's Commands table for how to turn
// this on from the real game.
export function scatterWithTestCluster(state: PuzzleState, bounds: { w: number; h: number }, rng: Rng, clusterSize: number = 10): PlacementBounds {
  const patch = connectedPatch(state, Math.min(clusterSize, state.pieceCount))

  // Sized from the patch's own real frames, not from bounds/pieceCount: bounds is the widened scatter
  // area (see scatterBounds), not the tight solved size a piece-count ratio would need to be accurate.
  // Same SCATTER_DENSITY the main scatter targets, and scaled by patch.length rather than a fixed
  // constant, so a bigger ?easyTest=N request gets a proportionally bigger box instead of the same one.
  const patchSize = Math.max(...patch.map((id) => Math.max(state.pieces[id]!.frame.width, state.pieces[id]!.frame.height)))
  const boxSize = patchSize * Math.sqrt(patch.length / SCATTER_DENSITY)

  // The corner box has to be reserved before the general scatter runs, not carved out of it afterward.
  // Placing every piece first and then overwriting just the patch's position (an earlier shape of this
  // function) left the general scatter free to put an unrelated piece in that same corner, since nothing
  // ever told it not to, two placement passes sharing one physical region with neither aware of the
  // other. Found by the user after an earlier fix only addressed placement *within* the patch, not the
  // patch against everyone else. See docs/journal.md.
  //
  // The fix: a full height strip of width boxSize on the left is reserved for the patch alone, the rest
  // of the pieces are placed only in what remains, then shifted right so they never enter the strip.
  const patchIds = new Set(patch)
  const generalIds = Array.from({ length: state.pieceCount }, (_, i) => i).filter((id) => !patchIds.has(id))
  const generalBounds = { w: Math.max(1, bounds.w - boxSize), h: bounds.h }

  const generalUsed = placeInGrid(state, generalIds, generalBounds, rng)
  for (const id of generalIds) state.x[id] = state.x[id]! + boxSize

  const patchUsed = placeInGrid(state, patch, { w: boxSize, h: boxSize }, rng)

  return {
    w: boxSize + generalUsed.w,
    h: Math.max(patchUsed.h, generalUsed.h),
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
