import { ImageSource, Rectangle, Sprite, Texture } from "pixi.js";
import { chooseGrid, makeRng, workingSize, type Grid, type WorkingSize } from "../core"
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

  const sheetTexture = new Texture({source: sources[0]!});
  const sheetSprite = new Sprite(sheetTexture);
  app.stage.addChild(sheetSprite);

  const piece = bake.pieces[0]!;
  const frame = new Rectangle(piece.frame.x,piece.frame.y,piece.frame.width,piece.frame.height);
  const texture = new Texture({source:sources[piece.atlas]!, frame});

  const pieceSprite = new Sprite(texture);
  pieceSprite.position.set(200,200);
  app.stage.addChild(pieceSprite);
  
  app.stage.removeChild(sheetSprite);
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