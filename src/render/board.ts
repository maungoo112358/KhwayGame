// The real board: camera pan/zoom, sprite management, drag/pick wiring into state/commands.ts. This is
// the mechanics src/stress/main.ts prototyped ad hoc for Phase 5's benchmarks, extracted here for real,
// Phase 8's A4. No benchmark instrumentation, no scatter, no save/resume, those are the caller's job,
// this module only ever renders and interacts with whatever PuzzleState it is handed.

import type { Application } from 'pixi.js'
import { Container, Graphics, ImageSource, Rectangle, Sprite, Texture } from 'pixi.js'
import { bakePiece, type AssembledPiece, type PuzzleBuild } from '../core'
import {
  applyCommand, buildSpatialHash, createClusterIndex, createCommandContext, findSnapTargets, pickAt,
  type ClusterIndex, type CommandContext, type PuzzleState, type SpatialHash,
} from '../state'

const LOCAL_ACTOR = 0
// Absolute scale, not a multiplier of some fit-to-table value: 1 is a piece's real baked size on
// screen, regardless of how many pieces exist or how big the table is. The zoom-out limit is the
// opposite of this, deliberately not a fixed constant, see minZoomToFit below.
const MAX_ZOOM = 5
const INITIAL_ZOOM = 1
const ZOOM_STEP = 1.15
// Experimental: a warm highlight on whichever piece the one being dragged would connect to if released
// right now. Snapping itself only happens on drop (see state/commands.ts), so without some hint the
// player has no idea a release is about to do anything until it already has. Plain Sprite.tint rather
// than a filter, cheapest possible version to judge the idea with before spending more on it.
const GLOW_TINT = 0xffdf9e

// A custom pan cursor, not the OS default: the system 'grab'/'grabbing' glyph varies by platform and
// theme, on this machine it renders as a flat white hand with no outline, unlike the arrow pointer next
// to it, which does have one. Drawing our own, with the same dark-outline-light-fill look as a normal
// pointer, keeps it legible and consistent regardless of OS theme. The keyword after the url() is a
// fallback only, used if the data URI somehow fails to decode.
function handCursor(svg: string, hotspotX: number, hotspotY: number, fallback: 'grab' | 'grabbing'): string {
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}') ${hotspotX} ${hotspotY}, ${fallback}`
}

const OPEN_HAND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round">
    <rect x="4.5" y="12.5" width="6.5" height="4.5" rx="2.2" transform="rotate(-30 7.75 14.75)"/>
    <rect x="8" y="12" width="9.5" height="9.5" rx="3.2"/>
    <rect x="8" y="4.2" width="2.6" height="9.3" rx="1.3"/>
    <rect x="11.1" y="3" width="2.6" height="10.5" rx="1.3"/>
    <rect x="14.2" y="4.2" width="2.6" height="9.3" rx="1.3"/>
    <rect x="17.3" y="6.2" width="2.6" height="7.8" rx="1.3"/>
  </g>
</svg>`

const CLOSED_FIST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round">
    <rect x="4" y="12.5" width="6" height="4.5" rx="2.2" transform="rotate(-20 7 14.75)"/>
    <rect x="7" y="9" width="12.5" height="10.5" rx="4"/>
    <rect x="9.5" y="9.5" width="2" height="3" rx="1"/>
    <rect x="13" y="9.5" width="2" height="3" rx="1"/>
    <rect x="16.5" y="9.5" width="2" height="3" rx="1"/>
  </g>
</svg>`

const CURSOR_GRAB = handCursor(OPEN_HAND_SVG, 12, 12, 'grab')
const CURSOR_GRABBING = handCursor(CLOSED_FIST_SVG, 12, 12, 'grabbing')

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

  // Every piece the currently dragged piece would connect to on release glows at once, not just one: a
  // piece dropped into a gap between two or more already-placed neighbours should show all of them lit,
  // the same set trySnap itself would merge with. Diffed against the previous set so a piece already
  // glowing does not flicker its tint every tick, only pieces actually entering or leaving the set change.
  let glowingIds: ReadonlySet<number> = new Set()
  function setGlow(ids: ReadonlySet<number>): void {
    for (const id of glowingIds) {
      if (!ids.has(id)) spritesById.get(id)!.tint = 0xffffff
    }
    for (const id of ids) {
      if (!glowingIds.has(id)) spritesById.get(id)!.tint = GLOW_TINT
    }
    glowingIds = ids
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

  // A single Drop can merge two, three, or more whole clusters at once (see state/commands.ts's
  // trySnap), not just the pieces the player's cursor was literally holding, dragging one piece drags
  // everything already welded to it, and it can now connect to every matching neighbour at once. Only
  // rebaking the pieces named in each Merge missed every other seam that became connected purely as a
  // side effect of clusters joining, which is exactly the leftover rim reported after solving a real
  // puzzle: the seam that showed it was never a piece anyone actually dragged, just a neighbour of it on
  // the other side of a merge. anchorId is any piece already known to be in the final, fully merged
  // cluster (the dragged piece itself always qualifies, whether or not anything merged), so looking up
  // its membership once gets every side of every merge this drop produced in one pass, not one call per
  // Merge. preDragMembers is a snapshot of the dragged piece's cluster taken before this drop, so pieces
  // that came from "the other side" of any of those merges can be told apart from ones that were already
  // together, without state/ needing to know rendering exists.
  function rebakeAcrossMerge(preDragMembers: ReadonlySet<number>, anchorId: number): void {
    const allMembers = clusters.membersOf(anchorId)
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

  // Starts the camera centered on the table itself, not pinned to its top-left corner. Pieces are
  // placed centered within tableBounds (see centerPlacement in state/puzzle.ts), so a corner-pinned
  // camera opened on empty table, every piece sat out of view in the middle of the table until the
  // player happened to pan there.
  const initialVisibleWidth = host.clientWidth / scale
  const initialVisibleHeight = host.clientHeight / scale
  board.position.set(
    (initialVisibleWidth / 2 - tableBounds.w / 2) * scale,
    (initialVisibleHeight / 2 - tableBounds.h / 2) * scale,
  )

  // Keeps board.position honest for whatever the current scale is: never showing table edges past
  // tableBounds when there is more table than viewport, and centered, not pinned to the top-left
  // corner, when there is more viewport than table (zoomed out far enough that the whole table already
  // fits). The old version only ever pinned the top-left corner and let leftover space pile up on the
  // right/bottom, which is invisible while there is no leftover space, but once the whole table fits
  // (guaranteed reachable now, see minZoomToFit below) that leftover space is the entire slack, and
  // pinning it to one corner reads as "snapped into the corner" on every
  // single move, since the valid range collapses to one point there. Shared by both the wheel handler
  // (zooming out can reach this state without any drag at all) and the pan-drag handler.
  function clampBoardPosition(): void {
    const visibleWidth = host.clientWidth / board.scale.x
    const leftEdgeX = tableBounds.w <= visibleWidth
      ? (tableBounds.w - visibleWidth) / 2
      : clamp(-board.position.x / board.scale.x, 0, tableBounds.w - visibleWidth)
    board.position.x = -leftEdgeX * board.scale.x

    const visibleHeight = host.clientHeight / board.scale.y
    const topEdgeY = tableBounds.h <= visibleHeight
      ? (tableBounds.h - visibleHeight) / 2
      : clamp(-board.position.y / board.scale.y, 0, tableBounds.h - visibleHeight)
    board.position.y = -topEdgeY * board.scale.y
  }
  clampBoardPosition()

  // True once the whole table already fits in the viewport on both axes, the same condition
  // clampBoardPosition centers on rather than clamps: at that point there is no slack left to pan
  // through, board.position is pinned to dead center no matter where a drag tries to push it. Used to
  // stop a pan from starting at all, rather than starting one that clamps back to the same spot on every
  // move, which felt like a broken drag rather than an intentionally locked one.
  function boardFullyVisible(): boolean {
    const visibleWidth = host.clientWidth / board.scale.x
    const visibleHeight = host.clientHeight / board.scale.y
    return tableBounds.w <= visibleWidth && tableBounds.h <= visibleHeight
  }

  // The zoom-out limit: the scale at which tableBounds exactly fits the viewport on its tighter axis,
  // the same "contain" fit a photo viewer uses, not a fixed constant like 0.1. A fixed floor is either
  // too tight, leaving the table's far edge forever off screen with no way to pan there (the border was
  // reported cut off at the bottom on a normal laptop window, this is that bug), or too loose, letting
  // the player zoom out past the whole table into surrounding empty space. Recomputed from host's actual
  // size on every call rather than cached, so it stays correct if the window is resized.
  function minZoomToFit(): number {
    return Math.min(host.clientWidth / tableBounds.w, host.clientHeight / tableBounds.h)
  }

  // A screen-space frame, a sibling of `board` on the stage rather than a child of it, so it never pans
  // or scales with the content. It marks the edge of the viewport itself, not the edge of the table:
  // those two only ever coincide on one axis (see minZoomToFit above, tableBounds and the window are
  // almost never the same shape), so a table-edge border always left the other axis unmarked. This one
  // sidesteps that entirely by not caring where the table is. Hidden until the player actually reaches
  // the zoom-out limit, where it appears as the "this is as far out as it goes" signal, then hides again
  // the moment they zoom back in.
  const zoomLimitBorder = new Graphics()
    .rect(0, 0, host.clientWidth, host.clientHeight)
    .stroke({ width: 2, color: 0xFF0000, alignment: 1 })
  zoomLimitBorder.visible = false
  app.stage.addChild(zoomLimitBorder)

  function updateZoomLimitBorder(): void {
    zoomLimitBorder.visible = boardFullyVisible()
  }
  updateZoomLimitBorder()

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
      scale = clamp(scale * factor, minZoomToFit(), MAX_ZOOM)

      board.position.set(cursorX - contentX * scale, cursorY - contentY * scale)
      board.scale.set(scale)
      clampBoardPosition()
      updateZoomLimitBorder()
      commandCtx.snapDistance = baseSnapDistance / scale
    },
    { passive: false },
  )

  let dragging: { pointerId: number; x: number; y: number } | null = null
  let draggingPiece: { pointerId: number; pieceId: number; x: number; y: number } | null = null

  // 'grab' hints that empty space can be dragged to pan, same convention map apps use. 'default' over a
  // piece, since that drags the piece itself, a different action, not the board. Only ever computed
  // while nothing is currently being dragged, mid-drag the cursor is set directly to 'grabbing' instead.
  function updateHoverCursor(clientX: number, clientY: number): void {
    const bounds = canvas.getBoundingClientRect()
    const contentX = (clientX - bounds.left - board.position.x) / board.scale.x
    const contentY = (clientY - bounds.top - board.position.y) / board.scale.y
    const hovering = pickAt({ x: contentX, y: contentY }, spatialHash, state)
    canvas.style.cursor = hovering || boardFullyVisible() ? 'default' : CURSOR_GRAB
  }

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
    } else if (!boardFullyVisible()) {
      dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
      canvas.style.cursor = CURSOR_GRABBING
    }
  })

  canvas.addEventListener('pointermove', (event) => {
    if (draggingPiece !== null && event.pointerId === draggingPiece.pointerId) {
      const deltaX = (event.clientX - draggingPiece.x) / board.scale.x
      const deltaY = (event.clientY - draggingPiece.y) / board.scale.y

      applyCommand(commandCtx, { type: 'Move', actorId: LOCAL_ACTOR, dx: deltaX, dy: deltaY })
      for (const memberId of clusters.membersOf(draggingPiece.pieceId)) moveSprite(memberId)

      // Preview only, applies nothing: snapping itself is checked once on drop, not here. This is what
      // lights up every piece a release would connect to right now, without connecting anything early.
      const previews = findSnapTargets(commandCtx, draggingPiece.pieceId)
      setGlow(new Set(previews.map((preview) => preview.neighborId)))

      draggingPiece = { ...draggingPiece, x: event.clientX, y: event.clientY }
      return
    }

    if (dragging === null || event.pointerId !== dragging.pointerId) {
      updateHoverCursor(event.clientX, event.clientY)
      return
    }

    board.position.x += event.clientX - dragging.x
    board.position.y += event.clientY - dragging.y
    clampBoardPosition()
    dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  })

  const pointerEndEvents: Array<'pointerup' | 'pointercancel'> = ['pointerup', 'pointercancel']
  for (const type of pointerEndEvents) {
    canvas.addEventListener(type, (event) => {
      if (draggingPiece !== null) {
        // pointerup is not guaranteed to be preceded by a pointermove at the same coordinates, a
        // browser is free to throttle pointermove to its own render cadence while pointerup fires
        // immediately, so the piece's logical position could still lag a little behind wherever it was
        // actually released. Left alone, that gap was exactly wide enough to miss a snap the player had
        // just seen glowing: the drop found nothing close enough, only a small nudge afterward did. One
        // final Move to this event's own coordinates closes that gap before anything checks distance.
        const finalDeltaX = (event.clientX - draggingPiece.x) / board.scale.x
        const finalDeltaY = (event.clientY - draggingPiece.y) / board.scale.y
        if (finalDeltaX !== 0 || finalDeltaY !== 0) {
          applyCommand(commandCtx, { type: 'Move', actorId: LOCAL_ACTOR, dx: finalDeltaX, dy: finalDeltaY })
          for (const memberId of clusters.membersOf(draggingPiece.pieceId)) moveSprite(memberId)
        }

        // Copied, not just referenced: ClusterIndex.membersOf hands back its live internal Set, and a
        // union that absorbs the dragged piece's own cluster into the bigger side would mutate this
        // "before" snapshot in place if it were not copied, corrupting the very comparison it exists
        // for. Taken before Drop, since that is the one command that can now actually merge something.
        const preDragMembers = new Set(clusters.membersOf(draggingPiece.pieceId))

        const merges = applyCommand(commandCtx, { type: 'Drop', actorId: LOCAL_ACTOR })
        if (merges.length > 0) {
          // trySnap's own position correction (inside applyMerge) moves every member of the dragged
          // cluster to align exactly with whatever it just merged into, real snapping, not just "close
          // enough". That changes state.x/y, but nothing had told the sprites to catch up to it: the
          // only moveSprite call in this handler runs before Drop, for the raw pointer delta, not after
          // it for whatever Drop itself corrected. Without this, a merge could succeed completely,
          // cluster union and all, while every sprite kept rendering wherever the mouse physically left
          // it, looking like nothing snapped at all.
          for (const memberId of clusters.membersOf(draggingPiece.pieceId)) moveSprite(memberId)
          rebakeAcrossMerge(preDragMembers, draggingPiece.pieceId)
        }
        setGlow(new Set())

        // Positions moved during a piece drag, the hash built at scatter time (or last drop) is stale
        // for whatever just moved. Rebuilding once here is cheap next to patching every cell every frame.
        spatialHash = buildSpatialHash(state, cellSize)
      }
      dragging = null
      draggingPiece = null
      updateHoverCursor(event.clientX, event.clientY)
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
