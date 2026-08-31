import { Container, ImageSource, Rectangle, Sprite, Texture } from "pixi.js";
import { ALPHA_MASK_SCALE, chooseGrid, makeRng, workingSize, type AssembledPiece, type Grid, type Point, type WorkingSize } from "../core"
import { createApp } from "../render/app";
import type { BakeRequest, BakeResponse, TreatRequest, TreatResponse } from "../worker/protocol";
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

async function runStress(): Promise<void>{
  const raw = await placeholderImage();

  let grid = chooseGrid(TARGET_PIECES, raw.width, raw.height);
  const size = workingSize(grid);
  const image = (await requestTreat(raw, size)).printed;
  grid = chooseGrid(TARGET_PIECES,image.width, image.height);
  const bake = await requestBake(image,grid);

  readout.textContent = `${bake.pieces.length} pieces, ${bake.atlases.length} sheet(s), baked in ${bake.bakeMs.toFixed(0)}ms`;

  const {app} = await createApp(canvasHost);

  const sources = bake.atlases.map((atlas)=> new ImageSource({resource: atlas}));

  const board = new Container();

  // One mutable current position per piece, independent of solved, this is what scattering (5.5) and
  // later dragging (5.9) actually move. Seeded so a reload scatters the same way twice.
  const scatterRng = makeRng(SEED, 'scatter');
  const current = new Map<number, Point>();
  bake.pieces.forEach((piece) => {
    current.set(piece.id, {
      x: scatterRng.range(0, Math.max(0, bake.working.w - piece.frame.width)),
      y: scatterRng.range(0, Math.max(0, bake.working.h - piece.frame.height)),
    });
  });

  // Spatial hash: cell size from real data, the square root of average area per piece, not a guess.
  // A piece bigger than one cell registers into every cell its bbox touches, so a query only ever has to
  // check the handful of pieces actually near a point, not all of them.
  const cellSize = Math.sqrt((bake.working.w * bake.working.h) / bake.pieces.length);
  const piecesById = new Map(bake.pieces.map((piece) => [piece.id, piece]));
  let spatialHash = buildSpatialHash(bake.pieces, current, cellSize);

  // Flat parent-pointer union-find over piece ids, this and the snap/merge logic below are the real,
  // reusable mechanics docs/roadmap.md calls out as outliving this throwaway page.
  const unionFind = createUnionFind(bake.pieces.length);
  // A fraction of real piece size, not an arbitrary pixel count.
  const snapDistance = cellSize * 0.3;
  const spritesById = new Map<number, Sprite>();

  function moveSprite(id: number, position: Point): void {
    const sprite = spritesById.get(id)!;
    const piece = piecesById.get(id)!;
    sprite.position.set(position.x - piece.anchor.x, position.y - piece.anchor.y);
  }

  // Checks the dragged piece's real grid neighbours, not proximity to any piece. Once merged, a group's
  // internal offsets never drift (every drag moves the whole group by one shared delta), so correcting
  // only the dragged piece's own existing group is enough, the neighbour's group is already consistent.
  function trySnap(pieceId: number): void {
    const piece = piecesById.get(pieceId)!;

    for (const neighborId of piece.neighbors) {
      if (neighborId === null) continue;
      if (unionFind.find(pieceId) === unionFind.find(neighborId)) continue;

      const neighbor = piecesById.get(neighborId)!;
      const neighborCurrent = current.get(neighborId)!;
      const pieceCurrent = current.get(pieceId)!;
      const target = {
        x: neighborCurrent.x + (piece.solved.x - neighbor.solved.x),
        y: neighborCurrent.y + (piece.solved.y - neighbor.solved.y),
      };

      if (Math.hypot(target.x - pieceCurrent.x, target.y - pieceCurrent.y) > snapDistance) continue;

      const deltaX = target.x - pieceCurrent.x;
      const deltaY = target.y - pieceCurrent.y;
      for (const memberId of unionFind.membersOf(pieceId)) {
        const memberCurrent = current.get(memberId)!;
        memberCurrent.x += deltaX;
        memberCurrent.y += deltaY;
        moveSprite(memberId, memberCurrent);
      }

      unionFind.union(pieceId, neighborId);
      return;
    }
  }

  // Walks the real neighbour graph breadth-first from one piece, unioning and instantly repositioning
  // each newly reached piece to its correct rigid offset, the same formula trySnap uses, just applied
  // directly instead of gated behind a live drag's snap distance. Idempotent: re-running just re-confirms
  // pieces that are already correctly placed. Returns the id any member of the finished cluster can be
  // looked up from.
  function buildTestCluster(size: number): number {
    const startId = 0;
    const visited = new Set<number>([startId]);
    const queue: number[] = [startId];

    while (queue.length > 0 && visited.size < size) {
      const anchorId = queue.shift()!;
      const anchor = piecesById.get(anchorId)!;

      for (const neighborId of anchor.neighbors) {
        if (neighborId === null || visited.has(neighborId) || visited.size >= size) continue;

        const neighbor = piecesById.get(neighborId)!;
        const anchorCurrent = current.get(anchorId)!;
        const neighborCurrent = current.get(neighborId)!;
        neighborCurrent.x = anchorCurrent.x + (neighbor.solved.x - anchor.solved.x);
        neighborCurrent.y = anchorCurrent.y + (neighbor.solved.y - anchor.solved.y);
        moveSprite(neighborId, neighborCurrent);

        unionFind.union(anchorId, neighborId);
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }

    spatialHash = buildSpatialHash(bake.pieces, current, cellSize);
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
      pickPieceAt(point, bake.pieces, current);
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
      pickPieceAtHashed(point, spatialHash, piecesById, cellSize, current);
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
    const memberCount = unionFind.membersOf(clusterMemberId).size;

    recorder.start();
    await scriptedClusterMove(app.ticker, 300, 150, 1500, (deltaX, deltaY) => {
      for (const memberId of unionFind.membersOf(clusterMemberId)) {
        const memberCurrent = current.get(memberId)!;
        memberCurrent.x += deltaX;
        memberCurrent.y += deltaY;
        moveSprite(memberId, memberCurrent);
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
    const picked = pickPieceAtHashed({ x: contentX, y: contentY }, spatialHash, piecesById, cellSize, current);

    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');

    if (picked) {
      draggingPiece = { pointerId: event.pointerId, pieceId: picked.id, x: event.clientX, y: event.clientY };
    } else {
      dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (draggingPiece !== null && event.pointerId === draggingPiece.pointerId) {
      const deltaX = (event.clientX - draggingPiece.x) / board.scale.x;
      const deltaY = (event.clientY - draggingPiece.y) / board.scale.y;

      for (const memberId of unionFind.membersOf(draggingPiece.pieceId)) {
        const memberCurrent = current.get(memberId)!;
        memberCurrent.x += deltaX;
        memberCurrent.y += deltaY;
        moveSprite(memberId, memberCurrent);
      }

      trySnap(draggingPiece.pieceId);
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
      if (draggingPiece !== null) spatialHash = buildSpatialHash(bake.pieces, current, cellSize);
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

    const picked = pickPieceAtHashed({ x: contentX, y: contentY }, spatialHash, piecesById, cellSize, current);
    const pickedId = picked ? picked.id : null;
    if (pickedId !== lastPickedId) {
      console.log(pickedId === null ? 'picked: none' : `picked: piece ${pickedId}`);
      lastPickedId = pickedId;
    }
  });

  app.stage.addChild(board);
  bake.pieces.forEach((piece)=>{
    const sprite = buildPieceSprite(piece, sources, current.get(piece.id)!)
    spritesById.set(piece.id, sprite);
    board.addChild(sprite);
  });

  // Debug hook for this stress page's own verification tooling only, not part of the game.
  (window as unknown as { __stress?: unknown }).__stress = { bake, current, board, unionFind };
}

interface UnionFind {
  find(id: number): number;
  union(a: number, b: number): void;
  membersOf(id: number): Set<number>;
}

// Flat Int32Array of parent pointers is the real backbone, path compressed on find. The root -> member
// set map is bookkeeping on top: raw union-find can answer "are these two in the same group" but not
// "who else is in my group", and cluster dragging needs that second answer every frame, not just at merge
// time. Union by size (merge the smaller member set into the larger) keeps that bookkeeping cheap too.
function createUnionFind(size: number): UnionFind {
  const parent = new Int32Array(size);
  const groups = new Map<number, Set<number>>();
  for (let i = 0; i < size; i++) {
    parent[i] = i;
    groups.set(i, new Set([i]));
  }

  function find(id: number): number {
    let root = id;
    while (parent[root] !== root) root = parent[root]!;

    let node = id;
    while (parent[node] !== root) {
      const next = parent[node]!;
      parent[node] = root;
      node = next;
    }
    return root;
  }

  function union(a: number, b: number): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;

    const membersA = groups.get(rootA)!;
    const membersB = groups.get(rootB)!;
    const bigger = membersA.size >= membersB.size ? rootA : rootB;
    const smaller = bigger === rootA ? rootB : rootA;
    const biggerMembers = groups.get(bigger)!;
    const smallerMembers = groups.get(smaller)!;

    for (const id of smallerMembers) biggerMembers.add(id);
    groups.delete(smaller);
    parent[smaller] = bigger;
  }

  function membersOf(id: number): Set<number> {
    return groups.get(find(id))!;
  }

  return { find, union, membersOf };
}

function buildPieceSprite(piece: AssembledPiece, sources: ImageSource[], current: Point): Sprite{

  const frame = new Rectangle(piece.frame.x, piece.frame.y, piece.frame.width,piece.frame.height);
  const texture = new Texture({source: sources[piece.atlas]!, frame});

  const pieceSprite = new Sprite(texture);
  pieceSprite.position.set(current.x-piece.anchor.x, current.y-piece.anchor.y);
  return pieceSprite;
}

// current is where the piece's anchor point actually sits right now (solved before 5.5, scattered after).
// current - anchor is therefore the same top-left corner the sprite is drawn from, and the same corner
// pieceAlphaMask built its mask relative to, which is what makes this conversion correct.
function pointInPieceMask(piece: AssembledPiece, current: Point, point: Point): boolean {
  const localX = (point.x - (current.x - piece.anchor.x)) * ALPHA_MASK_SCALE;
  const localY = (point.y - (current.y - piece.anchor.y)) * ALPHA_MASK_SCALE;
  const mx = Math.floor(localX);
  const my = Math.floor(localY);
  if (mx < 0 || mx >= piece.alphaMask.w || my < 0 || my >= piece.alphaMask.h) return false;

  const pixelIndex = my * piece.alphaMask.w + mx;
  const byteIndex = pixelIndex >> 3;
  const bitIndex = pixelIndex & 7;
  return (piece.alphaMask.bits[byteIndex]! & (1 << bitIndex)) !== 0;
}

// Deliberately naive: checks every piece, never exits early, this is the baseline 5.6 measures and 5.7's
// spatial hash replaces. Later matches overwrite earlier ones, so among overlapping pieces the one drawn
// on top (added to board last, highest id) wins, matching what the player would actually see and expect.
function pickPieceAt(point: Point, pieces: AssembledPiece[], current: Map<number, Point>): AssembledPiece | null {
  let picked: AssembledPiece | null = null;
  for (const piece of pieces) {
    if (pointInPieceMask(piece, current.get(piece.id)!, point)) picked = piece;
  }
  return picked;
}

function cellKey(cellX: number, cellY: number): string {
  return `${cellX},${cellY}`;
}

// Every piece registers into every cell its rendered bbox touches, current position plus frame size, not
// just the cell its corner happens to land in, otherwise a piece straddling a cell boundary would go
// missing from queries against its other cells.
function buildSpatialHash(pieces: AssembledPiece[], current: Map<number, Point>, cellSize: number): Map<string, number[]> {
  const hash = new Map<string, number[]>();

  for (const piece of pieces) {
    const pos = current.get(piece.id)!;
    const left = pos.x - piece.anchor.x;
    const top = pos.y - piece.anchor.y;

    const cellX0 = Math.floor(left / cellSize);
    const cellX1 = Math.floor((left + piece.frame.width) / cellSize);
    const cellY0 = Math.floor(top / cellSize);
    const cellY1 = Math.floor((top + piece.frame.height) / cellSize);

    for (let cy = cellY0; cy <= cellY1; cy++) {
      for (let cx = cellX0; cx <= cellX1; cx++) {
        const key = cellKey(cx, cy);
        const bucket = hash.get(key);
        if (bucket) bucket.push(piece.id);
        else hash.set(key, [piece.id]);
      }
    }
  }

  return hash;
}

// Same precise pointInPieceMask test as the naive version, only the candidate list is different: whatever
// is registered in the one cell the point falls in, instead of every piece on the board.
function pickPieceAtHashed(point: Point, hash: Map<string, number[]>, piecesById: Map<number, AssembledPiece>, cellSize: number, current: Map<number, Point>): AssembledPiece | null {
  const cellX = Math.floor(point.x / cellSize);
  const cellY = Math.floor(point.y / cellSize);
  const candidates = hash.get(cellKey(cellX, cellY));
  if (!candidates) return null;

  let picked: AssembledPiece | null = null;
  for (const id of candidates) {
    const piece = piecesById.get(id)!;
    if (pointInPieceMask(piece, current.get(id)!, point)) picked = piece;
  }
  return picked;
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

function requestBake(image: ImageBitmap, grid: Grid): Promise<BakeResponse &{type: 'result'}>{
  
     return new Promise<BakeResponse & {type: `result`}>((resolve, reject)=>{
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
       const request: BakeRequest = {type: 'bake', image, grid, seed:SEED};
       stressWorker.postMessage(request, [image]);

       if(image.width !==0){
        throw new Error('stress worker transfer did not neuter the source bitmap, zero copy gate failed');
       }
    })
}

void runStress();