import { describe, it, expect } from 'vitest'
import { hashImage } from './assemble'
import type { Grid } from './lattice'

// assembleAtlases itself touches OffscreenCanvas throughout and has no test file, same as bake.ts,
// verified by eye in the lab instead. hashImage is the one piece of this file that is pure arithmetic,
// no canvas involved, so it is the one piece that can be tested here. See docs/PHASE4-METADATA-NOTES.md.

const grid: Grid = { cols: 20, rows: 15, pieceCount: 300, imageWidth: 2000, imageHeight: 1500, cellWidth: 100, cellHeight: 100 }
const pixels = new Uint8ClampedArray([10, 20, 30, 255, 200, 100, 50, 255, 0, 0, 0, 255])

describe('hashImage', () => {
  // The determinism gate Phase 4 exists for: same inputs, same hash, every time.
  it('gives the same pixels, seed and grid the same hash every time', () => {
    expect(hashImage(pixels, 42, grid)).toBe(hashImage(pixels, 42, grid))
  })

  it('changes when the seed changes, same pixels and grid', () => {
    expect(hashImage(pixels, 1, grid)).not.toBe(hashImage(pixels, 2, grid))
  })

  it('changes when the grid changes, same seed and pixels', () => {
    const wider: Grid = { ...grid, cols: grid.cols + 1 }
    const taller: Grid = { ...grid, rows: grid.rows + 1 }
    expect(hashImage(pixels, 42, grid)).not.toBe(hashImage(pixels, 42, wider))
    expect(hashImage(pixels, 42, grid)).not.toBe(hashImage(pixels, 42, taller))
  })

  it('changes when a single pixel byte changes, same seed and grid', () => {
    const changed = Uint8ClampedArray.from(pixels)
    changed[0] = 11
    expect(hashImage(pixels, 42, grid)).not.toBe(hashImage(changed, 42, grid))
  })

  it('returns an unsigned 32 bit integer, same as mix32', () => {
    const h = hashImage(pixels, 42, grid)
    expect(Number.isInteger(h)).toBe(true)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(4294967296)
  })
})
