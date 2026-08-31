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

export function applyCommand(ctx: CommandContext, command: Command): void {
  switch (command.type) {
    case 'PickUp':
      return applyPickUp(ctx, command)
    case 'Move':
      return applyMove(ctx, command)
    case 'Drop':
      return applyDrop(ctx, command)
    case 'Merge':
      return applyMerge(ctx, command)
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

  trySnap(ctx, anchor)
}

function applyDrop(ctx: CommandContext, command: Drop): void {
  const anchor = ctx.actorAnchor.get(command.actorId)
  if (anchor === undefined) return

  for (const id of ctx.clusters.membersOf(anchor)) {
    ctx.state.heldBy[id] = -1
  }
  ctx.actorAnchor.delete(command.actorId)
}

// Checks the moved piece's real grid neighbours, not proximity to any piece. Once merged, a cluster's
// internal offsets never drift, every move applies the same delta to every member, so correcting only the
// anchor's own existing cluster against a neighbour is enough, the neighbour's cluster is already
// internally consistent. Carried over from src/stress/main.ts's trySnap, generalised to PuzzleState.
function trySnap(ctx: CommandContext, pieceId: number): void {
  const { state, clusters, snapDistance } = ctx
  const piece = state.pieces[pieceId]!

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

    applyMerge(ctx, { type: 'Merge', a: pieceId, b: neighborId }, target)
    return
  }
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
