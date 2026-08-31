// Browser storage for a saved puzzle. IndexedDB rather than localStorage: the working image blob alone
// can run to several megabytes, well past what localStorage can hold, and unlike core/'s canvas work
// this cannot be exercised in vitest either, no IndexedDB in that environment. Verified live in a real
// browser instead, same division bake.ts and assemble.ts already use.
//
// Per D11: the baked atlas sheets are never stored. A save is the treated working image (the input to
// the bake, not its output), the seed, the grid, the cut options, and the serialised PuzzleState.
// Loading re-bakes from those exact inputs, 1 to 3 seconds, and the resulting signature is checked
// against the one the save was made under before anything is trusted.
//
// state/ has no rule against DOM the way core/ does, only against Pixi, see docs/architecture.md's
// layer table. Save/resume is exactly the case that rule is carving room for.

import type { TabOptions, WarpOptions } from '../core'
import type { SavedPuzzleState } from './save'

export interface SavedPuzzle {
  signature: string
  seed: number
  grid: { cols: number; rows: number }
  cutOptions: { warp?: WarpOptions; tabs?: TabOptions }
  workingImage: Blob
  state: SavedPuzzleState
  savedAt: number
}

const DB_NAME = 'khwaygame-saves'
const DB_VERSION = 1
const STORE_NAME = 'puzzles'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'signature' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error as unknown as Error)
  })
}

// Wraps one IDBRequest as a promise, since IndexedDB's own API is callback based throughout.
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error as unknown as Error)
  })
}

export async function savePuzzle(record: SavedPuzzle): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  tx.objectStore(STORE_NAME).put(record)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error as unknown as Error)
  })
  db.close()
}

export async function loadPuzzle(signature: string): Promise<SavedPuzzle | undefined> {
  const db = await openDb()
  const tx = db.transaction(STORE_NAME, 'readonly')
  const record = await requestToPromise<SavedPuzzle | undefined>(tx.objectStore(STORE_NAME).get(signature))
  db.close()
  return record
}

export async function listPuzzles(): Promise<SavedPuzzle[]> {
  const db = await openDb()
  const tx = db.transaction(STORE_NAME, 'readonly')
  const records = await requestToPromise<SavedPuzzle[]>(tx.objectStore(STORE_NAME).getAll())
  db.close()
  return records
}

// This page only ever has one puzzle going at a time, no save-slot picker exists yet, that is Phase 8's
// job once there is a UI to pick among several. Newest by savedAt stands in until then.
export async function getLatestSave(): Promise<SavedPuzzle | undefined> {
  const all = await listPuzzles()
  if (all.length === 0) return undefined
  return all.reduce((latest, record) => (record.savedAt > latest.savedAt ? record : latest))
}

export async function deletePuzzle(signature: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  tx.objectStore(STORE_NAME).delete(signature)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error as unknown as Error)
  })
  db.close()
}

// PNG, not JPEG or WebP: lossy compression would change the treated image's raw pixel bytes, and
// hashImage folds those bytes into the signature, so a lossy round trip would make a resumed puzzle
// fail its own determinism check for no real reason.
export async function imageBitmapToPngBlob(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('this environment has no 2d canvas context')
  ctx.drawImage(bitmap, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}
