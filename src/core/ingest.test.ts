import { describe, it, expect } from 'vitest'
import { chooseGrid, gridOptions } from './lattice'
import { workingSize, TARGET_PIECE_SIZE } from './ingest'

// Only the arithmetic is tested here. ingestImage is one call to a browser API, and the value in this module is the sum that decides how big the atlas gets.

describe('workingSize', () => {
  // The worked example, with round numbers so the whole chain is checkable by hand.
  //
  // A 6000 by 4000 upload at 600 pieces gives a 30 by 20 grid, so cells are 200 by 200 source pixels.
  // Wanting 110 pixel pieces means scaling by 110/200 = 0.55, giving 3300 by 2200, and 3300 * 2200 / 600 is 12100, whose square root is exactly 110.
  it('scales a 6000px upload to hit the target piece size', () => {
    const grid = chooseGrid(600, 6000, 4000)
    expect([grid.cols, grid.rows, grid.cellWidth]).toEqual([30, 20, 200])

    const size = workingSize(grid, 110)

    expect(size.scale).toBeCloseTo(0.55, 12)
    expect(size.width).toBe(3300)
    expect(size.height).toBe(2200)
    expect(size.pieceSize).toBeCloseTo(110, 9)
    expect(size.limitedBySource).toBe(false)
  })

  // The headline property. Two uploads of the same shape produce the identical working image, so the atlas budget is not set by whoever uploads the biggest file.
  it('gives the same working image for any large enough upload of the same shape', () => {
    const first = workingSize(chooseGrid(600, 6000, 4000), 110)
    const second = workingSize(chooseGrid(600, 4500, 3000), 110)
    const third = workingSize(chooseGrid(600, 3600, 2400), 110)

    expect([second.width, second.height]).toEqual([first.width, first.height])
    expect([third.width, third.height]).toEqual([first.width, first.height])
  })

  // Distorting the photo to make cells square would be a visible change, up to about 5%, for no benefit.
  it('preserves the aspect ratio of the upload', () => {
    let inspected = 0

    for (const [width, height] of [[6000, 4000], [4000, 6000], [5000, 5000], [6000, 2000], [3000, 4000]]) {
      for (const { grid } of gridOptions(width!, height!)) {
        const size = workingSize(grid)
        const before = width! / height!
        const after = size.width / size.height

        // Rounding to whole pixels is the only thing allowed to move this, which is why the tolerance is relative to the smaller dimension rather than absolute.
        expect(Math.abs(after - before) / before, `${width} by ${height}`).toBeLessThan(2 / Math.min(size.width, size.height))
        inspected++
      }
    }

    expect(inspected).toBe(15)
  })

  it('lands near the target piece size across every band and shape', () => {
    let inspected = 0

    for (const [width, height] of [[6000, 4000], [4000, 6000], [5000, 5000], [9000, 3000]]) {
      for (const { band, grid } of gridOptions(width!, height!)) {
        const size = workingSize(grid)

        // Two roundings sit between the target and the result, chooseGrid's and this one, and neither moves it far.
        expect(Math.abs(size.pieceSize - TARGET_PIECE_SIZE), `${band.name} on ${width} by ${height}`).toBeLessThan(1)
        inspected++
      }
    }

    expect(inspected).toBe(12)
  })

  // A bigger puzzle out of the same photo needs more pixels, because the piece size is what is being held constant.
  it('grows the working image with the piece count', () => {
    const [small, medium, large] = gridOptions(6000, 4000).map(({ grid }) => workingSize(grid))

    expect(medium!.width).toBeGreaterThan(small!.width)
    expect(large!.width).toBeGreaterThan(medium!.width)
  })

  // Enlarging invents no detail and costs atlas space quadratically, so a small upload simply gets softer pieces and says so.
  it('refuses to upscale a small upload, and reports that it did', () => {
    const grid = chooseGrid(600, 800, 600)
    const size = workingSize(grid, 110)

    expect(size.scale).toBe(1)
    expect(size.width).toBe(800)
    expect(size.height).toBe(600)
    expect(size.limitedBySource).toBe(true)

    // The reported piece size is what was achieved, not what was asked for.
    expect(size.pieceSize).toBeLessThan(110)
    expect(size.pieceSize).toBeCloseTo(Math.sqrt((800 * 600) / grid.pieceCount), 9)
  })

  // The boundary between the two behaviours, checked from both sides rather than assumed.
  it('switches to limited exactly when the source cell drops below the target', () => {
    // 30 by 20 cells, so a width of 30 * 110 = 3300 is the smallest upload that can deliver 110 pixel pieces.
    expect(workingSize(chooseGrid(600, 3300, 2200), 110).limitedBySource).toBe(false)
    expect(workingSize(chooseGrid(600, 3299, 2199), 110).limitedBySource).toBe(true)
  })

  // Piece size is the whole VRAM lever, so a caller passing nonsense must not quietly produce a one pixel atlas.
  it('rejects a target piece size that makes no sense', () => {
    const grid = chooseGrid(600, 6000, 4000)

    expect(() => workingSize(grid, 0)).toThrow()
    expect(() => workingSize(grid, -110)).toThrow()
    expect(() => workingSize(grid, Number.NaN)).toThrow()
  })

  // The number the atlas budget in docs/ARCHITECTURE.md is based on, checked rather than trusted.
  it('keeps a thousand pieces inside two 4096 square sheets, before packing waste', () => {
    const grid = chooseGrid(1000, 6000, 4000)
    const size = workingSize(grid)

    const piecePixels = size.width * size.height
    const twoSheets = 2 * 4096 * 4096

    expect(piecePixels).toBeLessThan(twoSheets)

    // Tab overhang and packing waste have to fit in what is left, so the bare pieces need real headroom rather than only just fitting.
    expect(piecePixels / twoSheets).toBeLessThan(0.5)
  })
})
