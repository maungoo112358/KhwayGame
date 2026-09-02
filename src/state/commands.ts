// Discrete commands that mutate PuzzleState, so nothing ever pokes the typed arrays directly. Required
// for co-op later per docs/architecture.md's forward compatibility notes: mutations expressed as data are
// what a future networked peer could serialise and replay, not because anything replays them yet.

import type { Point } from '../core'
import type { ClusterIndex } from './unionFind'
import type { PuzzleState } from './puzzle'

export interface PickUp {
  type: 'PickUp'
  pieceId: number
  actorId: number
}

export interface Move {
  type: 'Move'
  actorId: number
  dx: number
  dy: number
}

export interface Drop {
  type: 'Drop'
  actorId: number
}

export interface Merge {
  type: 'Merge'
  a: number
  b: number
}

export type Command = PickUp | Move | Drop | Merge

export interface CommandContext {
  state: PuzzleState
  clusters: ClusterIndex
  // A fraction of real piece size, not an arbitrary pixel count. Carried over from src/stress/main.ts.
  snapDistance: number
  // Which piece each actor is currently holding. Not part of PuzzleState: it is per-session input book
  // keeping, not puzzle progress, and has no business being saved or resumed. heldBy on PuzzleState is
  // the read side render/ looks at, this map is the write side commands consult.
  actorAnchor: Map<number, number>
}

export function createCommandContext(state: PuzzleState, clusters: ClusterIndex, snapDistance: number): CommandContext {
  return { state, clusters, snapDistance, actorAnchor: new Map() }
}

// Returns every Merge that actually happened, if any, so a caller that cares (render/board.ts, to
// redraw the pieces involved without the rim between them) can react without state/ knowing anything
// about rendering. Only 'Drop' can ever produce any, the others always report none. Snapping used to be
// checked on every 'Move', which meant merely passing near a matching piece on the way somewhere else
// would connect it, an unwanted "magnet" feel with no player intent behind it. Checking only on release
// is what a real piece does too, nothing pulls at your hand mid-air, it only locks in once set down.
// It can report more than one: a piece dropped into a gap surrounded by several already-placed
// neighbours connects to all of them at once, the way setting a real piece into a hole does, not just
// whichever neighbour happened to be checked first.
export function applyCommand(ctx: CommandContext, command: Command): Merge[] {
  switch (command.type) {
    case 'PickUp':
      applyPickUp(ctx, command)
      return []
    case 'Move':
      applyMove(ctx, command)
      return []
    case 'Drop':
      return applyDrop(ctx, command)
    case 'Merge':
      applyMerge(ctx, command)
      return [command]
  }
}

function applyPickUp(ctx: CommandContext, command: PickUp): void {
  ctx.actorAnchor.set(command.actorId, command.pieceId)
  for (const id of ctx.clusters.membersOf(command.pieceId)) {
    ctx.state.heldBy[id] = command.actorId
  }
}

function applyMove(ctx: CommandContext, command: Move): void {
  const anchor = ctx.actorAnchor.get(command.actorId)
  if (anchor === undefined) return

  for (const id of ctx.clusters.membersOf(anchor)) {
    ctx.state.x[id] = ctx.state.x[id]! + command.dx
    ctx.state.y[id] = ctx.state.y[id]! + command.dy
  }
}

function applyDrop(ctx: CommandContext, command: Drop): Merge[] {
  const anchor = ctx.actorAnchor.get(command.actorId)
  if (anchor === undefined) return []

  const merges = trySnap(ctx, anchor)

  for (const id of ctx.clusters.membersOf(anchor)) {
    ctx.state.heldBy[id] = -1
  }
  ctx.actorAnchor.delete(command.actorId)

  return merges
}

export interface SnapTarget {
  neighborId: number
  target: Point
}

// The pure half of snapping: every real, unconnected grid neighbour this piece is currently close
// enough to that releasing it right now would merge with, each with the exact rigid position that merge
// would correct it to. Applies nothing. Exists so render/ can preview a snap while a piece is still
// being dragged, e.g. to glow every piece it would connect to at once, not just one, without state/
// knowing rendering exists and without duplicating this search in two places.
export function findSnapTargets(ctx: CommandContext, pieceId: number): SnapTarget[] {
  const { state, clusters, snapDistance } = ctx
  const piece = state.pieces[pieceId]!
  const found: SnapTarget[] = []

  for (const neighborId of piece.neighbors) {
    if (neighborId === null) continue
    if (clusters.find(pieceId) === clusters.find(neighborId)) continue

    const neighbor = state.pieces[neighborId]!
    const target: Point = {
      x: state.x[neighborId]! + (piece.solved.x - neighbor.solved.x),
      y: state.y[neighborId]! + (piece.solved.y - neighbor.solved.y),
    }
    const current: Point = { x: state.x[pieceId]!, y: state.y[pieceId]! }

    if (Math.hypot(target.x - current.x, target.y - current.y) > snapDistance) continue

    found.push({ neighborId, target })
  }

  return found
}

// Checks every one of the moved piece's real grid neighbours, not proximity to any piece, and merges
// with each one currently close enough, not just the first: a piece set into a gap between several
// already-placed neighbours (a corner between two solved edges, or the last piece in a hole surrounded
// on every side) connects to all of them in one drop, the way it would physically. Once merged, a
// cluster's internal offsets never drift, every move applies the same delta to every member, so
// correcting the anchor's own cluster against each neighbour in turn is enough, re-reading its position
// fresh before each one means a correction made for an earlier neighbour is respected when checking the
// next, rather than every distance being judged against where the piece was before any of them applied.
// Carried over from src/stress/main.ts's trySnap, generalised to PuzzleState.
function trySnap(ctx: CommandContext, pieceId: number): Merge[] {
  const { state, clusters, snapDistance } = ctx
  const piece = state.pieces[pieceId]!
  const merges: Merge[] = []

  for (const neighborId of piece.neighbors) {
    if (neighborId === null) continue
    if (clusters.find(pieceId) === clusters.find(neighborId)) continue

    const neighbor = state.pieces[neighborId]!
    const target: Point = {
      x: state.x[neighborId]! + (piece.solved.x - neighbor.solved.x),
      y: state.y[neighborId]! + (piece.solved.y - neighbor.solved.y),
    }
    const current: Point = { x: state.x[pieceId]!, y: state.y[pieceId]! }

    if (Math.hypot(target.x - current.x, target.y - current.y) > snapDistance) continue

    const merge: Merge = { type: 'Merge', a: pieceId, b: neighborId }
    applyMerge(ctx, merge, target)
    merges.push(merge)
  }

  return merges
}

// The position correction and the union both belong to one merge: correcting first, then unioning, is
// what keeps a cluster's internal offsets exact instead of drifting by whatever the snap tolerance let
// through. target is only ever supplied by trySnap, which already computed the rigid offset. A merge
// triggered any other way has no correction to make, positions are assumed already aligned.
// Idempotent and commutative by construction: clusters.union is a no-op if a and b already share a root,
// and it picks the larger group to absorb the smaller by size alone, never by which argument came first.
function applyMerge(ctx: CommandContext, command: Merge, target?: Point): void {
  const { state, clusters } = ctx

  if (target) {
    const deltaX = target.x - state.x[command.a]!
    const deltaY = target.y - state.y[command.a]!
    for (const memberId of clusters.membersOf(command.a)) {
      state.x[memberId] = state.x[memberId]! + deltaX
      state.y[memberId] = state.y[memberId]! + deltaY
    }
  }

  clusters.union(command.a, command.b)
}
