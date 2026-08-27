import { Container, ImageSource, Rectangle, Sprite, Texture } from "pixi.js";
import { chooseGrid, makeRng, workingSize, type AssembledPiece, type Grid, type WorkingSize } from "../core"
import { createApp } from "../render/app";
import type { BakeRequest, BakeResponse, TreatRequest, TreatResponse } from "../worker/protocol";


function need<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) throw new Error(`stress.html is missing ${selector}`)
  return element
}

const canvasHost = need<HTMLDivElement>('#canvas');
const readout = need<HTMLDivElement>('#readout');

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

  canvas.addEventListener('pointerdown', (event) => {
  dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }

  canvas.setPointerCapture(event.pointerId)
  canvas.classList.add('dragging')
  });

  canvas.addEventListener('pointermove', (event) => {
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
      dragging = null
      canvas.classList.remove('dragging')
    })
  }

  app.stage.addChild(board);
  bake.pieces.forEach((piece)=>{
    const sprite = buildPieceSprite(piece,sources)
    board.addChild(sprite);
  });
}

function buildPieceSprite(piece: AssembledPiece, sources: ImageSource[]): Sprite{
   
  const frame = new Rectangle(piece.frame.x, piece.frame.y, piece.frame.width,piece.frame.height);
  const texture = new Texture({source: sources[piece.atlas]!, frame});

  const pieceSprite = new Sprite(texture);
  pieceSprite.position.set(piece.solved.x-piece.anchor.x, piece.solved.y-piece.anchor.y);
  return pieceSprite;
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