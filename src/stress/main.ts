import { Container, ImageSource, Rectangle, Sprite, Texture } from "pixi.js";
import { chooseGrid, makeRng, workingSize, type Grid, type TabOptions, type WarpOptions, type WorkingSize } from "../core"
import { createApp } from "../render/app";
import type { BakeRequest, BakeResponse, TreatRequest, TreatResponse } from "../worker/protocol";
import {
  applyCommand, buildSpatialHash, createClusterIndex, createCommandContext, createPuzzleState,
  deletePuzzle, getLatestSave, imageBitmapToPngBlob, pickAt, pickAtNaive, restorePuzzleState,
  savePuzzle, scatterPieces, serializePuzzleState,
  type ClusterIndex, type CommandContext, type PuzzleState, type SavedPuzzle, type SpatialHash,
} from "../state";
import { clearMeasurements, createFrameRecorder, measurementsFor, onKeyPress, passesFrameBudget, percentiles, readMemory, renderPanel, scriptedClusterMove, scriptedPan, scriptedProbe } from "./harness";


function need<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) throw new Error(`stress.html is missing ${selector}`)
  return element
}

const canvasHost = need<HTMLDivElement>('#canvas');
const readout = need<HTMLDivElement>('#readout');
const harness = need<HTMLDivElement>("#harness");

const TARGET_PIECES = 1000;
const SEED = 20260818;

// This page is single player. A real actor id exists because state/commands.ts already refuses to
// assume one player, per docs/architecture.md's forward compatibility notes, not because anything here
// is multiplayer yet.
const LOCAL_ACTOR = 0;

const MIN_ZOOM = 1
const MAX_ZOOM = 40
const ZOOM_STEP = 1.15

// A function rather than an inline null check, because narrowing a module level const does not follow into function bodies.
function context2d(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = target.getContext('2d')
  if (ctx === null) throw new Error('this browser has no 2d canvas context')
  return ctx
}

// The player supplies the image in the real game, so the lab ships no assets and draws its own stand in.
// Deliberately busy, because a flat colour would hide a misaligned cut. The corner to corner diagonals are the giveaway: if the coordinate mapping is wrong they miss the corners.
// Sized like a real camera upload rather than like a thumbnail, so the default view exercises the downscale path.
// At 1600 by 1200 every band came out limitedBySource, which demonstrated the clamp and hid the normal case.
async function placeholderImage(): Promise<ImageBitmap> {
  const source = document.createElement('canvas')
  source.width = 4000
  source.height = 3000

  const ctx = context2d(source)

  const sky = ctx.createLinearGradient(0, 0, 0, source.height)
  sky.addColorStop(0, '#6d9dc5')
  sky.addColorStop(1, '#e8c9a0')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, source.width, source.height)

  // Seeded, so the stand in is the same picture every reload and a changed cut cannot be blamed on a changed image.
  const rng = makeRng(20260818, 'lab-placeholder')
  for (let i = 0; i < 40; i++) {
    ctx.beginPath()
    // Radii as a fraction of the width, so the picture keeps its proportions if the canvas size ever changes again.
    ctx.arc(rng.range(0, source.width), rng.range(0, source.height), rng.range(0.019, 0.088) * source.width, 0, Math.PI * 2)
    ctx.fillStyle = `hsl(${rng.range(0, 360).toFixed(0)} 55% 60% / 0.55)`
    ctx.fill()
  }

  ctx.strokeStyle = 'rgb(255 255 255 / 0.8)'
  ctx.lineWidth = 10
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(source.width, source.height)
  ctx.moveTo(source.width, 0)
  ctx.lineTo(0, source.height)
  ctx.stroke()

  return createImageBitmap(source)
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

interface LivePuzzle {
  bake: BakeResult
  state: PuzzleState
  workingImageBlob: Blob
}

// The full fresh path: placeholder, treat, bake, scatter. The working image blob is extracted before
// requestBake transfers and neuters the bitmap, see the gotcha in docs/status.md, since it needs to
// survive baking to be saved later.
async function freshPuzzle(): Promise<LivePuzzle> {
  const raw = await placeholderImage();

  let grid = chooseGrid(TARGET_PIECES, raw.width, raw.height);
  const size = workingSize(grid);
  const image = (await requestTreat(raw, size)).printed;
  grid = chooseGrid(TARGET_PIECES, image.width, image.height);

  const workingImageBlob = await imageBitmapToPngBlob(image);
  const bake = await requestBake(image, grid);

  const state = createPuzzleState(bake);
  // Seeded, so a reload scatters the same way twice, same reasoning as the placeholder image itself.
  scatterPieces(state, bake.working, makeRng(SEED, 'scatter'));

  return { bake, state, workingImageBlob }
}

// PuzzleBuild.grid only carries cols and rows, requestBake needs the full Grid chooseGrid produces:
// pieceCount, imageWidth/imageHeight and cellWidth/cellHeight. All four are exact arithmetic on cols,
// rows and the working image's own dimensions (see core/lattice.ts's chooseGrid), not another guess, so
// reconstructing them here is not a second, possibly different chooseGrid call, it is the same numbers.
function reconstructGrid(colsRows: { cols: number; rows: number }, working: { w: number; h: number }): Grid {
  return {
    cols: colsRows.cols,
    rows: colsRows.rows,
    pieceCount: colsRows.cols * colsRows.rows,
    imageWidth: working.w,
    imageHeight: working.h,
    cellWidth: working.w / colsRows.cols,
    cellHeight: working.h / colsRows.rows,
  }
}

// Re-bakes from the saved working image rather than trusting saved geometry directly: PuzzleBuild is
// never stored, per D11, the only way back to real pieces is baking again from what produced them the
// first time. Returns null rather than throwing on a signature mismatch, a corrupt or stale save should
// fall back to a fresh puzzle, not crash the page.
async function tryResume(existing: SavedPuzzle): Promise<LivePuzzle | null> {
  const image = await createImageBitmap(existing.workingImage)
  const grid = reconstructGrid(existing.grid, { w: image.width, h: image.height })
  const bake = await requestBake(image, grid, existing.seed, existing.cutOptions.warp, existing.cutOptions.tabs)

  if (bake.signature !== existing.signature) {
    console.warn(`saved puzzle signature mismatch (expected ${existing.signature}, got ${bake.signature}), starting fresh instead`)
    return null
  }

  const state = restorePuzzleState(bake, existing.state)
  return { bake, state, workingImageBlob: existing.workingImage }
}

async function runStress(): Promise<void>{
  const existing = await getLatestSave();
  const resumed = existing ? await tryResume(existing) : null;
  const { bake, state, workingImageBlob } = resumed ?? await freshPuzzle();

  readout.textContent = `${bake.pieces.length} pieces, ${bake.atlases.length} sheet(s), signature ${bake.signature}${resumed ? ' (resumed from save)' : ''}. Press s to save.`;
  // Phase 7.3's determinism gate is verified across two full page loads, not by calling assembleAtlases
  // twice in one process, see docs/roadmap.md. This line is what a browser check reads.
  console.log(`puzzle signature: ${bake.signature}`);

  const {app} = await createApp(canvasHost);

  const sources = bake.atlases.map((atlas)=> new ImageSource({resource: atlas}));

  const board = new Container();

  // Spatial hash: cell size from real data, the square root of average area per piece, not a guess. A
  // piece bigger than one cell registers into every cell its bbox touches, so a query only ever has to
  // check the handful of pieces actually near a point, not all of them.
  const cellSize = Math.sqrt((bake.working.w * bake.working.h) / bake.pieces.length);
  let spatialHash: SpatialHash = buildSpatialHash(state, cellSize);

  // Cluster membership and the command layer that mutates state, both real state/ mechanics now rather
  // than this page's own copies.
  const clusters: ClusterIndex = createClusterIndex(state.parent);
  // A fraction of real piece size, not an arbitrary pixel count.
  const snapDistance = cellSize * 0.3;
  const commandCtx: CommandContext = createCommandContext(state, clusters, snapDistance);
  const spritesById = new Map<number, Sprite>();

  function moveSprite(id: number): void {
    const sprite = spritesById.get(id)!;
    const piece = state.pieces[id]!;
    sprite.position.set(state.x[id]! - piece.anchor.x, state.y[id]! - piece.anchor.y);
  }

  // Walks the real neighbour graph breadth-first from one piece, unioning and instantly repositioning
  // each newly reached piece to its correct rigid offset. Test scaffolding for the 'c' benchmark key
  // only, a real player never issues a command like this, so it works directly against clusters and
  // state rather than going through PickUp/Move/Drop. Idempotent: re-running just re-confirms pieces
  // that are already correctly placed. Returns the id any member of the finished cluster can be looked
  // up from.
  function buildTestCluster(size: number): number {
    const startId = 0;
    const visited = new Set<number>([startId]);
    const queue: number[] = [startId];

    while (queue.length > 0 && visited.size < size) {
      const anchorId = queue.shift()!;
      const anchor = state.pieces[anchorId]!;

      for (const neighborId of anchor.neighbors) {
        if (neighborId === null || visited.has(neighborId) || visited.size >= size) continue;

        const neighbor = state.pieces[neighborId]!;
        state.x[neighborId] = state.x[anchorId]! + (neighbor.solved.x - anchor.solved.x);
        state.y[neighborId] = state.y[anchorId]! + (neighbor.solved.y - anchor.solved.y);
        moveSprite(neighborId);

        clusters.union(anchorId, neighborId);
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }

    spatialHash = buildSpatialHash(state, cellSize);
    return startId;
  }

  const recorder = createFrameRecorder(app.ticker);

  onKeyPress('p', async()=>{
    recorder.start();
    await scriptedPan(app.ticker,board, 11, 11, 1500);
    recorder.stop();
    const frames = recorder.samples();
    const tiles = percentiles(frames);
    const pessesFrame = passesFrameBudget(tiles.p95);
    const readRam = readMemory(bake.atlases.length, bake.atlases[0]!.width);

    const lines = [
      `p50: ${tiles.p50.toFixed()}ms`,
      `p90: ${tiles.p90.toFixed()}ms`,
      `p95: ${tiles.p95.toFixed()}ms`,
      `p99: ${tiles.p99.toFixed()}ms`,
      `max: ${tiles.max.toFixed()}ms`,
      `heap: ${readRam.heapMB === null ? 'is Null or Empty': readRam.heapMB.toFixed(1) + 'MB'}`,
      `vram estimate: ${readRam.vramEstimateMB.toFixed(1)}MB`,
      `55fps gate: ${pessesFrame ? 'PASS':'FAIL'}`,
    ]
    renderPanel(harness, lines);
  });

  onKeyPress('l', async () => {
    clearMeasurements('pick-naive');
    await scriptedProbe(app.ticker, 0, 0, bake.working.w, bake.working.h, 1500, 'pick-naive', (point) => {
      pickAtNaive(point, state);
    });

    const pickTiles = percentiles(measurementsFor('pick-naive'));
    const pickLines = [
      `pick p50: ${pickTiles.p50.toFixed(3)}ms`,
      `pick p90: ${pickTiles.p90.toFixed(3)}ms`,
      `pick p95: ${pickTiles.p95.toFixed(3)}ms`,
      `pick p99: ${pickTiles.p99.toFixed(3)}ms`,
      `pick max: ${pickTiles.max.toFixed(3)}ms`,
    ];
    renderPanel(harness, pickLines);
  });

  onKeyPress('h', async () => {
    clearMeasurements('pick-spatial');
    await scriptedProbe(app.ticker, 0, 0, bake.working.w, bake.working.h, 1500, 'pick-spatial', (point) => {
      pickAt(point, spatialHash, state);
    });

    const hashTiles = percentiles(measurementsFor('pick-spatial'));
    const hashLines = [
      `hash p50: ${hashTiles.p50.toFixed(3)}ms`,
      `hash p90: ${hashTiles.p90.toFixed(3)}ms`,
      `hash p95: ${hashTiles.p95.toFixed(3)}ms`,
      `hash p99: ${hashTiles.p99.toFixed(3)}ms`,
      `hash max: ${hashTiles.max.toFixed(3)}ms`,
    ];
    renderPanel(harness, hashLines);
  });

  const CLUSTER_TEST_SIZE = 300;

  onKeyPress('c', async () => {
    const clusterMemberId = buildTestCluster(CLUSTER_TEST_SIZE);
    const memberCount = clusters.membersOf(clusterMemberId).size;

    recorder.start();
    await scriptedClusterMove(app.ticker, 300, 150, 1500, (deltaX, deltaY) => {
      for (const memberId of clusters.membersOf(clusterMemberId)) {
        state.x[memberId] = state.x[memberId]! + deltaX;
        state.y[memberId] = state.y[memberId]! + deltaY;
        moveSprite(memberId);
      }
    });
    recorder.stop();

    const clusterTiles = percentiles(recorder.samples());
    const clusterPass = passesFrameBudget(clusterTiles.p95);
    const clusterLines = [
      `cluster(${memberCount}) p50: ${clusterTiles.p50.toFixed(2)}ms`,
      `cluster(${memberCount}) p90: ${clusterTiles.p90.toFixed(2)}ms`,
      `cluster(${memberCount}) p95: ${clusterTiles.p95.toFixed(2)}ms`,
      `cluster(${memberCount}) p99: ${clusterTiles.p99.toFixed(2)}ms`,
      `cluster(${memberCount}) max: ${clusterTiles.max.toFixed(2)}ms`,
      `55fps gate: ${clusterPass ? 'PASS' : 'FAIL'}`,
    ];
    renderPanel(harness, clusterLines);
  });

  // 7.4's own gate: save, reload the page, resume, pieces are exactly where they were left. cutOptions
  // is saved as {} here, this page never passes custom warp/tabs to requestBake, a real UI slider would
  // fill this in once Phase 8 has one.
  onKeyPress('s', async () => {
    const record: SavedPuzzle = {
      signature: bake.signature,
      seed: bake.seed,
      grid: bake.grid,
      cutOptions: {},
      workingImage: workingImageBlob,
      state: serializePuzzleState(state),
      savedAt: Date.now(),
    };
    await savePuzzle(record);
    readout.textContent = `saved at ${new Date(record.savedAt).toLocaleTimeString()}. Reload the page to resume.`;
  });

  let zoom = MIN_ZOOM;
  const canvas = app.canvas;
  const fitScale = Math.min(canvasHost.clientWidth/bake.working.w,canvasHost.clientHeight/bake.working.h);
  board.scale.set(fitScale);

    canvas.addEventListener('wheel', (event)=>{
      event.preventDefault();
      const bounds = app.canvas.getBoundingClientRect();

      const cursorX = event.clientX - bounds.left;
      const cursorY = event.clientY - bounds.top;
      const contentX = (cursorX - board.position.x) / board.scale.x;
      const contentY = (cursorY - board.position.y) / board.scale.y;

      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const target = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const newScale = fitScale * target;

      board.position.set(cursorX - contentX * newScale, cursorY - contentY *newScale);
      board.scale.set(newScale);
      zoom = target;
    },
    {passive:false},
  );

  let dragging: { pointerId: number; x: number; y: number } | null = null
  let draggingPiece: { pointerId: number; pieceId: number; x: number; y: number } | null = null

  canvas.addEventListener('pointerdown', (event) => {
    const bounds = app.canvas.getBoundingClientRect();
    const cursorX = event.clientX - bounds.left;
    const cursorY = event.clientY - bounds.top;
    const contentX = (cursorX - board.position.x) / board.scale.x;
    const contentY = (cursorY - board.position.y) / board.scale.y;
    const picked = pickAt({ x: contentX, y: contentY }, spatialHash, state);

    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');

    if (picked) {
      draggingPiece = { pointerId: event.pointerId, pieceId: picked.id, x: event.clientX, y: event.clientY };
      applyCommand(commandCtx, { type: 'PickUp', pieceId: picked.id, actorId: LOCAL_ACTOR });
    } else {
      dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (draggingPiece !== null && event.pointerId === draggingPiece.pointerId) {
      const deltaX = (event.clientX - draggingPiece.x) / board.scale.x;
      const deltaY = (event.clientY - draggingPiece.y) / board.scale.y;

      applyCommand(commandCtx, { type: 'Move', actorId: LOCAL_ACTOR, dx: deltaX, dy: deltaY });
      for (const memberId of clusters.membersOf(draggingPiece.pieceId)) moveSprite(memberId);

      draggingPiece = { ...draggingPiece, x: event.clientX, y: event.clientY };
      return;
    }

    if (dragging === null || event.pointerId !== dragging.pointerId) return

    board.position.x += event.clientX - dragging.x;
    board.position.y += event.clientY - dragging.y;
    const visibleWidth = Math.min(bake.working.w, canvasHost.clientWidth / board.scale.x)
    const leftEdgeX = clamp(-board.position.x / board.scale.x, 0, Math.max(0, bake.working.w - visibleWidth))
    board.position.x = -leftEdgeX * board.scale.x

    const visibleHeight = Math.min(bake.working.h, canvasHost.clientHeight / board.scale.y)
    const topEdgeY = clamp(-board.position.y / board.scale.y, 0, Math.max(0, bake.working.h - visibleHeight))
    board.position.y = -topEdgeY * board.scale.y
    dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  });

  for (const type of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(type, () => {
      // Positions moved during a piece drag, the hash built at scatter time (or last drop) is stale for
      // whatever just moved. Rebuilding once here is cheap next to patching every cell on every frame.
      if (draggingPiece !== null) {
        applyCommand(commandCtx, { type: 'Drop', actorId: LOCAL_ACTOR });
        spatialHash = buildSpatialHash(state, cellSize);
      }
      dragging = null
      draggingPiece = null
      canvas.classList.remove('dragging')
    })
  }

  // Live naive picking, separate listener from the drag one above so panning and picking never fight over
  // the same event. Logs only on change, not every move, checkable by eye without flooding the console.
  let lastPickedId: number | null = null;
  canvas.addEventListener('pointermove', (event) => {
    const bounds = app.canvas.getBoundingClientRect();
    const cursorX = event.clientX - bounds.left;
    const cursorY = event.clientY - bounds.top;
    const contentX = (cursorX - board.position.x) / board.scale.x;
    const contentY = (cursorY - board.position.y) / board.scale.y;

    const picked = pickAt({ x: contentX, y: contentY }, spatialHash, state);
    const pickedId = picked ? picked.id : null;
    if (pickedId !== lastPickedId) {
      console.log(pickedId === null ? 'picked: none' : `picked: piece ${pickedId}`);
      lastPickedId = pickedId;
    }
  });

  app.stage.addChild(board);
  for (let id = 0; id < state.pieceCount; id++) {
    const sprite = buildPieceSprite(state, id, sources);
    spritesById.set(id, sprite);
    board.addChild(sprite);
  }

  // Debug hook for this stress page's own verification tooling only, not part of the game. refreshHash
  // exists so an external script can move a piece directly (bypassing the pointer path) and still have
  // picking find it afterward, without reaching into this closure's own spatialHash variable.
  (window as unknown as { __stress?: unknown }).__stress = {
    bake, state, clusters, board,
    refreshHash: () => { spatialHash = buildSpatialHash(state, cellSize) },
    resumed: resumed !== null,
    clearSave: () => deletePuzzle(bake.signature),
  };
}

function buildPieceSprite(state: PuzzleState, id: number, sources: ImageSource[]): Sprite {
  const piece = state.pieces[id]!;
  const frame = new Rectangle(piece.frame.x, piece.frame.y, piece.frame.width, piece.frame.height);
  const texture = new Texture({ source: sources[piece.atlas]!, frame });

  const sprite = new Sprite(texture);
  sprite.position.set(state.x[id]! - piece.anchor.x, state.y[id]! - piece.anchor.y);
  return sprite;
}

const stressWorker = new Worker(new URL('../worker/treat-worker.ts', import.meta.url), { type: 'module' });

function requestTreat(source: ImageBitmap, size: WorkingSize): Promise<{plain: ImageBitmap; printed: ImageBitmap; printMs: number}>{
  return new Promise((resolve, reject)=>{
    function handleMessage(event: MessageEvent<TreatResponse>): void{
      const message = event.data;
      if(message.type === 'progress'){
        readout.textContent = `${message.stage}...`;
        return;
      }

      stressWorker.removeEventListener('message', handleMessage);
      if(message.type === 'error'){
        reject(new Error(message.message));
      }else{
        resolve(message);
      }
    }
      stressWorker.addEventListener('message', handleMessage);

      const request: TreatRequest = {type: 'treat', source, size};
      stressWorker.postMessage(request, [source]);

      if(source.width !== 0){
        throw new Error('stress worker transfer did not neuter the source bitmap, zero copy gate failed');
      }
      })
}

// seed/warp/tabs default to this page's own constants, but a resumed puzzle passes back whatever it was
// actually baked with (D22: cutOptions is not part of the signature, so reproducing the exact same
// geometry on resume depends on this, not on the signature check).
function requestBake(image: ImageBitmap, grid: Grid, seed: number = SEED, warp?: WarpOptions, tabs?: TabOptions): Promise<BakeResult>{

     return new Promise<BakeResult>((resolve, reject)=>{
       function handleMessage(event: MessageEvent<BakeResponse>): void{
        const message = event.data;
        if(message.type === 'progress'){
          readout.textContent = `baking ${message.completed} of ${message.total} pieces...`;
          return;
        }

        stressWorker.removeEventListener('message', handleMessage);
        if(message.type === 'error'){
          reject(new Error(message.message));
        }else{
          resolve(message);
        }
       }

       stressWorker.addEventListener('message', handleMessage);
       const request: BakeRequest = {type: 'bake', image, grid, seed, warp, tabs};
       stressWorker.postMessage(request, [image]);

       if(image.width !==0){
        throw new Error('stress worker transfer did not neuter the source bitmap, zero copy gate failed');
       }
    })
}

type BakeResult = BakeResponse & { type: 'result' }

void runStress();
