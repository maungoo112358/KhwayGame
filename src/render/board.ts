// The real board: camera pan/zoom, sprite management, drag/pick wiring into state/commands.ts. This is
// the mechanics src/stress/main.ts prototyped ad hoc for Phase 5's benchmarks, extracted here for real,
// Phase 8's A4. No benchmark instrumentation, no scatter, no save/resume, those are the caller's job,
// this module only ever renders and interacts with whatever PuzzleState it is handed.

import type { Application } from 'pixi.js'
import { Container, Graphics, ImageSource, Rectangle, Sprite, Texture, TilingSprite } from 'pixi.js'
import { bakePiece, type AssembledPiece, type PuzzleBuild } from '../core'
import {
  applyCommand, buildSpatialHash, createClusterIndex, createCommandContext, findSnapTargets, isSolved, pickAt,
  type ClusterIndex, type CommandContext, type PuzzleState, type SpatialHash,
} from '../state'
import { createReferenceSlider } from '../ui/referenceImage'

const LOCAL_ACTOR = 0
// Absolute scale, not a multiplier of some fit-to-table value: 1 is a piece's real baked size on
// screen, regardless of how many pieces exist or how big the table is. The zoom-out limit is the
// opposite of this, deliberately not a fixed constant, see minZoomToFit below.
const MAX_ZOOM = 5
const INITIAL_ZOOM = 1
const ZOOM_STEP = 1.15
// The snap itself stays instant, deliberately, per art-direction.md and D30, real pieces click into
// place rather than glide there. This is the "settle" that plays right after: a brief pop up past its
// resting scale and back down, on the two pieces a Merge actually just joined. Experimental, same
// spirit as GLOW_TINT below, judge it live before spending more on it.
const BOUNCE_DURATION_MS = 180
const BOUNCE_PEAK_SCALE = 1.12
// Experimental: a warm highlight on whichever piece the one being dragged would connect to if released
// right now. Snapping itself only happens on drop (see state/commands.ts), so without some hint the
// player has no idea a release is about to do anything until it already has. Plain Sprite.tint rather
// than a filter, cheapest possible version to judge the idea with before spending more on it.
const GLOW_TINT = 0xffdf9e

const CURSOR_GRABBING = 'grabbing'

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

// A tileable grain texture for the table, warm oat per art-direction.md's starting palette, the same
// tone the flat background already used. A flat fill looks identical no matter where the camera is
// pointed, so panning has nothing to visibly slide past. Wood grain, not a scatter of soft round dots:
// dots at this density read as mottled skin/pores, first version tried that and it looked wrong. Grain
// lines are also better motion cues than dots, a line sliding sideways is easy to track by eye. This
// texture goes on tableLayer (see below), the same moving world the pieces live in, not a screen-space
// overlay, so the grain actually slides when the camera pans.
function createTableTexture(): Texture {
  const size = 320
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#EDE6DA'
  ctx.fillRect(0, 0, size, size)

  // Long, gently wavy streaks running roughly left to right, real wood grain drifts rather than
  // running dead straight. Sparse and low opacity on purpose, this is meant to read as a material,
  // not compete with the pieces sitting on top of it.
  const lineCount = 12
  for (let i = 0; i < lineCount; i++) {
    const baseY = (i + 0.5) * (size / lineCount) + (Math.random() - 0.5) * 8
    const dark = Math.random() < 0.6
    ctx.strokeStyle = dark ? 'rgba(74, 68, 60, 0.07)' : 'rgba(255, 255, 255, 0.06)'
    ctx.lineWidth = 1 + Math.random()
    ctx.beginPath()
    ctx.moveTo(0, baseY)
    for (let x = 0; x <= size; x += 16) {
      const wobble = Math.sin((x / size) * Math.PI * 2 + i) * 3
      ctx.lineTo(x, baseY + wobble)
    }
    ctx.stroke()
  }

  // A few small knots/flecks, sparse, not the dominant feature.
  for (let i = 0; i < 25; i++) {
    const x = Math.random() * size
    const y = Math.random() * size
    const radius = Math.random() * 1 + 0.4
    ctx.fillStyle = 'rgba(74, 68, 60, 0.06)'
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  }

  return new Texture({ source: new ImageSource({ resource: canvas }) })
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
export function createBoard(app: Application, host: HTMLElement, bake: PuzzleBuild, state: PuzzleState, tableBounds: { w: number; h: number }, treatedImage: ImageBitmap, onSolved?: () => void): Board {
  const sources = bake.atlases.map((atlas) => new ImageSource({ resource: atlas }))
  const board = new Container()

  // A separate container, not a child of `board`, even though it needs the exact same pan/zoom
  // transform (kept in sync at the end of clampBoardPosition below). It has to be its own stage child
  // so it can sit under the reference popup in z-order: the popup is added to the stage before `board`
  // so a dragged piece paints over it, but this background isn't a piece, it's the table the popup
  // lies on, and a table has to be under a photo lying on it, not over it. Added to the stage here,
  // before the popup gets created, so its z-order is locked in early.
  const tableLayer = new Container()
  const tableBackground = new TilingSprite({ texture: createTableTexture(), width: tableBounds.w, height: tableBounds.h })
  tableLayer.addChild(tableBackground)
  app.stage.addChild(tableLayer)

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
    sprite.position.set(state.x[id]!, state.y[id]!)
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

  // Start time (performance.now(), real elapsed milliseconds, not a frame count) per piece currently
  // mid-bounce. A ticker callback below reads this every frame and writes the corresponding sprite's
  // scale; startBounce only ever records when a bounce began, the callback owns the actual animating.
  const bouncingSince = new Map<number, number>()
  function startBounce(id: number): void {
    bouncingSince.set(id, performance.now())
  }
  app.ticker.add(() => {
    if (bouncingSince.size === 0) return
    const now = performance.now()
    for (const [id, start] of bouncingSince) {
      const t = (now - start) / BOUNCE_DURATION_MS
      if (t >= 1) {
        spritesById.get(id)!.scale.set(1)
        bouncingSince.delete(id)
        continue
      }
      // sin(t * pi) is 0 at t=0, rises smoothly to 1 exactly at the midpoint (t=0.5), back to 0 at
      // t=1: one smooth pulse up to BOUNCE_PEAK_SCALE and back to resting size, not a sharp triangle.
      const scale = 1 + (BOUNCE_PEAK_SCALE - 1) * Math.sin(t * Math.PI)
      spritesById.get(id)!.scale.set(scale)
    }
  })

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
  //
  // Returns the same "gained a connection" set it rebaked, so a caller wanting to react to every real
  // seam that just formed (the bounce settle effect below) can reuse this exact computation rather than
  // reading trySnap's own Merge[] return value, which under-reports: once a dragged piece unions with
  // any one already-connected neighbour, every other neighbour already sharing that neighbour's cluster
  // reads as "already merged" to trySnap's own union-find check and never gets its own Merge entry,
  // even though it is a real seam that just formed. A center piece dropped into a fully solved ring of
  // 4 neighbours is a real case of this, not a corner case: trySnap reports exactly one Merge, but four
  // seams actually just closed.
  function rebakeAcrossMerge(preDragMembers: ReadonlySet<number>, anchorId: number): ReadonlySet<number> {
    const allMembers = clusters.membersOf(anchorId)
    const gainedConnectionIds = new Set<number>()
    for (const id of allMembers) {
      const wasOnDraggedSide = preDragMembers.has(id)
      const piece = state.pieces[id]!
      const gainedConnection = piece.neighbors.some((neighborId) => {
        if (neighborId === null || !allMembers.has(neighborId)) return false
        return preDragMembers.has(neighborId) !== wasOnDraggedSide
      })
      if (gainedConnection) {
        rebakeConnected(id)
        gainedConnectionIds.add(id)
      }
    }
    return gainedConnectionIds
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

    // tableLayer is a separate stage child (see its own comment above), not a child of `board`, so it
    // does not inherit board's transform for free. Every place board's position or scale changes calls
    // this function right after, so copying here in one spot keeps the two in lockstep everywhere.
    tableLayer.position.set(board.position.x, board.position.y)
    tableLayer.scale.set(board.scale.x, board.scale.y)
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

  // Right-click reference popup, Phase 8 B3, see D32. A Pixi sprite and border, not a DOM overlay: it
  // has to sit inside the same canvas as the real pieces, added to the stage here, before `board` goes
  // on at the very end of this function, so a dragged piece (a `board` child) paints over it through
  // ordinary Pixi z-order, the same reason a real piece would cover a photo lying underneath it on a
  // table. A DOM element can never do that, DOM stacking is all-or-nothing against a whole `<canvas>`,
  // it cannot interleave with content painted inside one.
  const referenceTexture = new Texture({ source: new ImageSource({ resource: treatedImage }) })
  const referenceSprite = new Sprite(referenceTexture)
  referenceSprite.anchor.set(0.5)
  const referenceBorder = new Graphics()
    .rect(-bake.working.w / 2, -bake.working.h / 2, bake.working.w, bake.working.h)
    .stroke({ width: 2, color: 0x000000, alignment: 1 })
  const referenceContainer = new Container()
  referenceContainer.addChild(referenceSprite, referenceBorder)
  referenceContainer.visible = false
  app.stage.addChild(referenceContainer)

  // The slider is the one piece of this feature that stays DOM, an ordinary form control, but its
  // screen position still has to track the Pixi sprite's own size (see updateReferenceTransform), so
  // it keeps sitting just below the picture rather than drifting away from it as the player zooms.
  const referenceSlider = createReferenceSlider((opacity) => {
    referenceSprite.alpha = opacity
  })
  host.appendChild(referenceSlider.element)

  function updateReferenceTransform(): void {
    referenceContainer.position.set(host.clientWidth / 2, host.clientHeight / 2)
    referenceContainer.scale.set(scale)
    referenceSlider.setTop(host.clientHeight / 2 + (bake.working.h * scale) / 2 + 20)
    referenceSlider.setWidth(bake.working.w * scale)
  }
  updateReferenceTransform()

  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    referenceContainer.visible = !referenceContainer.visible
    referenceSlider.setVisible(referenceContainer.visible)
  })

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()

      // Anchored to the screen center, not the cursor: zooming toward the mouse (the earlier
      // behaviour) recentres the camera on wherever the mouse happens to be on every scroll tick, so
      // zooming out and back in rarely lands you back where you started, and it never agrees with the
      // reference popup, which is always fixed to this same screen center. Anchoring here instead makes
      // a zoom in/out round trip repeatable, and keeps the board and the popup in the same frame.
      const anchorX = host.clientWidth / 2
      const anchorY = host.clientHeight / 2
      const contentX = (anchorX - board.position.x) / board.scale.x
      const contentY = (anchorY - board.position.y) / board.scale.y

      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      scale = clamp(scale * factor, minZoomToFit(), MAX_ZOOM)

      board.position.set(anchorX - contentX * scale, anchorY - contentY * scale)
      board.scale.set(scale)
      clampBoardPosition()
      updateZoomLimitBorder()
      updateReferenceTransform()
      commandCtx.snapDistance = baseSnapDistance / scale
    },
    { passive: false },
  )

  let dragging: { pointerId: number; x: number; y: number } | null = null
  let draggingPiece: { pointerId: number; pieceId: number; x: number; y: number } | null = null

  canvas.addEventListener('pointerdown', (event) => {
    // Button 1 is the middle button. It default-behaves as a browser autoscroll/paste trigger unless
    // prevented, since this canvas gives it a real meaning (panning) instead.
    if (event.button === 1) event.preventDefault()

    canvas.setPointerCapture(event.pointerId)

    if (event.button === 0) {
      const bounds = canvas.getBoundingClientRect()
      const cursorX = event.clientX - bounds.left
      const cursorY = event.clientY - bounds.top
      const contentX = (cursorX - board.position.x) / board.scale.x
      const contentY = (cursorY - board.position.y) / board.scale.y
      const picked = pickAt({ x: contentX, y: contentY }, spatialHash, state)
      if (picked) {
        draggingPiece = { pointerId: event.pointerId, pieceId: picked.id, x: event.clientX, y: event.clientY }
        applyCommand(commandCtx, { type: 'PickUp', pieceId: picked.id, actorId: LOCAL_ACTOR })
      }
    } else if (event.button === 1 && !boardFullyVisible()) {
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

    if (dragging === null || event.pointerId !== dragging.pointerId) return

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

          // Every piece that gained a real connection this drop, not trySnap's own merges: see
          // rebakeAcrossMerge's comment, a piece dropped into a fully solved gap can close several real
          // seams at once while trySnap's union-find only ever reports the first, the rest already read
          // as "same cluster" the instant that first one unions. Only these pieces, not every member of
          // either whole cluster: a big already-solved region merging with one more piece should not
          // pulse as a whole, only the join itself is new.
          for (const id of rebakeAcrossMerge(preDragMembers, draggingPiece.pieceId)) startBounce(id)

          // isSolved can only newly become true right after a merge, nothing else changes cluster
          // membership. Checked here rather than every frame, once per merge is the only time it can
          // possibly flip.
          if (isSolved(state, clusters)) onSolved?.()
        }
        setGlow(new Set())

        // Positions moved during a piece drag, the hash built at scatter time (or last drop) is stale
        // for whatever just moved. Rebuilding once here is cheap next to patching every cell every frame.
        spatialHash = buildSpatialHash(state, cellSize)
      }
      dragging = null
      draggingPiece = null
      canvas.style.cursor = 'default'
    })
  }

  for (const piece of bake.pieces) {
    const frame = new Rectangle(piece.frame.x, piece.frame.y, piece.frame.width, piece.frame.height)
    const texture = new Texture({ source: sources[piece.atlas]!, frame })

    const sprite = new Sprite(texture)
    // Pivoted at the piece's own anchor point (its solved position, expressed as a local offset from
    // the texture's own top-left corner) rather than left at the texture's default (0, 0) origin, so a
    // scale animation (see startBounce below) pops outward from a point on the piece itself, not from
    // its top-left corner, which would read as the piece also sliding as it grew.
    sprite.pivot.set(piece.anchor.x, piece.anchor.y)
    sprite.position.set(state.x[piece.id]!, state.y[piece.id]!)
    spritesById.set(piece.id, sprite)
    board.addChild(sprite)
  }

  app.stage.addChild(board)

  return { container: board, clusters }
}
