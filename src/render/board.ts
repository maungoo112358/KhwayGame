// The real board: camera pan/zoom, sprite management, drag/pick wiring into state/commands.ts. This is
// the mechanics src/stress/main.ts prototyped ad hoc for Phase 5's benchmarks, extracted here for real,
// Phase 8's A4. No benchmark instrumentation, no scatter, no save/resume, those are the caller's job,
// this module only ever renders and interacts with whatever PuzzleState it is handed.

import type { Application } from 'pixi.js'
import { Container, ImageSource, Rectangle, Sprite, Texture } from 'pixi.js'
import { bakePiece, type AssembledPiece, type PuzzleBuild } from '../core'
import {
  applyCommand, buildSpatialHash, createClusterIndex, createCommandContext, pickAt,
  type ClusterIndex, type CommandContext, type PuzzleState, type SpatialHash,
} from '../state'

const LOCAL_ACTOR = 0
// Absolute scale, not a multiplier of some fit-to-table value: 1 is a piece's real baked size on
// screen, regardless of how many pieces exist or how big the table is.
const MIN_ZOOM = 0.1
const MAX_ZOOM = 5
const INITIAL_ZOOM = 1
const ZOOM_STEP = 1.15

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

export interface Board {
  container: Container
  clusters: ClusterIndex
}

// tableBounds is the real pannable area, wider than bake.working: solved size has zero slack (solved
// pieces tile it edge to edge), scattering into that exact area is what crammed pieces on top of each
// other, see state/puzzle.ts's scatterBounds. The camera has to agree with whatever area scattering
// actually used, or panning would clip off pieces sitting outside bake.working's own footprint.
// treatedImage is the same photo the atlases were baked from, kept alive by the caller specifically so
// a piece can be baked again on demand, see rebakeConnected below.
export function createBoard(app: Application, host: HTMLElement, bake: PuzzleBuild, state: PuzzleState, tableBounds: { w: number; h: number }, treatedImage: ImageBitmap): Board {
  const sources = bake.atlases.map((atlas) => new ImageSource({ resource: atlas }))
  const board = new Container()

  // Spatial hash: cell size from real data, the square root of average area per piece, not a guess.
  const cellSize = Math.sqrt((bake.working.w * bake.working.h) / bake.pieces.length)
  let spatialHash: SpatialHash = buildSpatialHash(state, cellSize)

  const clusters: ClusterIndex = createClusterIndex(state.parent)
  // A fraction of real piece size, not an arbitrary pixel count. This is the tolerance at real (1x)
  // scale specifically, not a fixed content-space distance: state/ has no idea what zoom is, so the
  // wheel handler below rescales commandCtx.snapDistance whenever scale changes, keeping the tolerance
  // a constant number of screen pixels instead of a constant number of content pixels. Without this, the
  // same content-space radius meant strict, fussy snapping zoomed out and overly generous snapping
  // zoomed in, since a screen-pixel mouse movement covers more content the further out the camera is.
  const baseSnapDistance = cellSize * 0.3
  const commandCtx: CommandContext = createCommandContext(state, clusters, baseSnapDistance)
  const spritesById = new Map<number, Sprite>()

  function moveSprite(id: number): void {
    const sprite = spritesById.get(id)!
    const piece = state.pieces[id]!
    sprite.position.set(state.x[id]! - piece.anchor.x, state.y[id]! - piece.anchor.y)
  }

  // Re-bakes one piece with the rim punched out wherever a real, currently connected neighbour covers
  // it, then swaps the sprite over to that fresh bitmap. AssembledPiece already carries every field
  // bakePiece's PieceGeometry parameter needs (id, col, row, path, bbox, solved, neighbors), so no
  // conversion is needed, state.pieces[id] is passed straight through. Cheap enough to run inline on the
  // pointer thread: a single piece bakes in a fraction of a millisecond, see docs/status.md's 3.6 numbers
  // (972 pieces in 681ms). The re-baked piece stops sharing the shared atlas sheet in exchange, one extra
  // draw call per piece that has ever connected to something, not a real cost at real puzzle scale.
  function rebakeConnected(id: number): void {
    const piece = state.pieces[id]!
    const connected: AssembledPiece[] = []
    for (const neighborId of piece.neighbors) {
      if (neighborId === null) continue
      if (clusters.find(id) !== clusters.find(neighborId)) continue
      connected.push(state.pieces[neighborId]!)
    }

    const bitmap = bakePiece(piece, treatedImage, undefined, connected)
    spritesById.get(id)!.texture = new Texture({ source: new ImageSource({ resource: bitmap }) })
  }

  // A single Move can merge two whole clusters, not just the two pieces the player's cursor was
  // literally holding, dragging one piece drags everything already welded to it. Only rebaking
  // merge.a/merge.b missed every other seam that became connected purely as a side effect of the two
  // groups joining, which is exactly the leftover rim reported after solving a real puzzle: the seam
  // that showed it was never the piece anyone actually dragged, just a neighbour of it on the other
  // side of the merge. preDragMembers is a snapshot of the dragged piece's cluster taken before this
  // move, so pieces that came from "the other side" of the merge can be told apart from ones that were
  // already together, without state/ needing to know rendering exists.
  function rebakeAcrossMerge(preDragMembers: ReadonlySet<number>, merge: { a: number; b: number }): void {
    const allMembers = clusters.membersOf(merge.a)
    for (const id of allMembers) {
      const wasOnDraggedSide = preDragMembers.has(id)
      const piece = state.pieces[id]!
      const gainedConnection = piece.neighbors.some((neighborId) => {
        if (neighborId === null || !allMembers.has(neighborId)) return false
        return preDragMembers.has(neighborId) !== wasOnDraggedSide
      })
      if (gainedConnection) rebakeConnected(id)
    }
  }

  // Fixed at a real, meaningful zoom on load, not fit-to-viewport: fitting the whole table into view
  // made a piece's screen size depend on the table size, which depends on piece count, a small demo
  // puzzle zoomed in past its real size and a large one zoomed out to near nothing. It also left no
  // room to pan, since the fitted view already showed the entire table. See docs/status.md.
  let scale = INITIAL_ZOOM
  const canvas = app.canvas
  board.scale.set(scale)

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const bounds = canvas.getBoundingClientRect()

      const cursorX = event.clientX - bounds.left
      const cursorY = event.clientY - bounds.top
      const contentX = (cursorX - board.position.x) / board.scale.x
      const contentY = (cursorY - board.position.y) / board.scale.y

      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      scale = clamp(scale * factor, MIN_ZOOM, MAX_ZOOM)

      board.position.set(cursorX - contentX * scale, cursorY - contentY * scale)
      board.scale.set(scale)
      commandCtx.snapDistance = baseSnapDistance / scale
    },
    { passive: false },
  )

  let dragging: { pointerId: number; x: number; y: number } | null = null
  let draggingPiece: { pointerId: number; pieceId: number; x: number; y: number } | null = null

  canvas.addEventListener('pointerdown', (event) => {
    const bounds = canvas.getBoundingClientRect()
    const cursorX = event.clientX - bounds.left
    const cursorY = event.clientY - bounds.top
    const contentX = (cursorX - board.position.x) / board.scale.x
    const contentY = (cursorY - board.position.y) / board.scale.y
    const picked = pickAt({ x: contentX, y: contentY }, spatialHash, state)

    canvas.setPointerCapture(event.pointerId)

    if (picked) {
      draggingPiece = { pointerId: event.pointerId, pieceId: picked.id, x: event.clientX, y: event.clientY }
      applyCommand(commandCtx, { type: 'PickUp', pieceId: picked.id, actorId: LOCAL_ACTOR })
    } else {
      dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    }
  })

  canvas.addEventListener('pointermove', (event) => {
    if (draggingPiece !== null && event.pointerId === draggingPiece.pointerId) {
      const deltaX = (event.clientX - draggingPiece.x) / board.scale.x
      const deltaY = (event.clientY - draggingPiece.y) / board.scale.y

      // Copied, not just referenced: ClusterIndex.membersOf hands back its live internal Set, and a
      // union that absorbs the dragged piece's own cluster into the bigger side would mutate this
      // "before" snapshot in place if it were not copied, corrupting the very comparison it exists for.
      const preDragMembers = new Set(clusters.membersOf(draggingPiece.pieceId))

      const merge = applyCommand(commandCtx, { type: 'Move', actorId: LOCAL_ACTOR, dx: deltaX, dy: deltaY })
      for (const memberId of clusters.membersOf(draggingPiece.pieceId)) moveSprite(memberId)
      if (merge !== null) rebakeAcrossMerge(preDragMembers, merge)

      draggingPiece = { ...draggingPiece, x: event.clientX, y: event.clientY }
      return
    }

    if (dragging === null || event.pointerId !== dragging.pointerId) return

    board.position.x += event.clientX - dragging.x
    board.position.y += event.clientY - dragging.y
    const visibleWidth = Math.min(tableBounds.w, host.clientWidth / board.scale.x)
    const leftEdgeX = clamp(-board.position.x / board.scale.x, 0, Math.max(0, tableBounds.w - visibleWidth))
    board.position.x = -leftEdgeX * board.scale.x

    const visibleHeight = Math.min(tableBounds.h, host.clientHeight / board.scale.y)
    const topEdgeY = clamp(-board.position.y / board.scale.y, 0, Math.max(0, tableBounds.h - visibleHeight))
    board.position.y = -topEdgeY * board.scale.y
    dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  })

  for (const type of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(type, () => {
      // Positions moved during a piece drag, the hash built at scatter time (or last drop) is stale
      // for whatever just moved. Rebuilding once here is cheap next to patching every cell every frame.
      if (draggingPiece !== null) {
        applyCommand(commandCtx, { type: 'Drop', actorId: LOCAL_ACTOR })
        spatialHash = buildSpatialHash(state, cellSize)
      }
      dragging = null
      draggingPiece = null
    })
  }

  for (const piece of bake.pieces) {
    const frame = new Rectangle(piece.frame.x, piece.frame.y, piece.frame.width, piece.frame.height)
    const texture = new Texture({ source: sources[piece.atlas]!, frame })

    const sprite = new Sprite(texture)
    sprite.position.set(state.x[piece.id]! - piece.anchor.x, state.y[piece.id]! - piece.anchor.y)
    spritesById.set(piece.id, sprite)
    board.addChild(sprite)
  }

  app.stage.addChild(board)

  return { container: board, clusters }
}
