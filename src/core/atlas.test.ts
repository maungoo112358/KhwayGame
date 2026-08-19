import { describe, it, expect } from 'vitest'
import { packAtlas, type AtlasRect } from './atlas'
import { chooseGrid } from './lattice'
import { createWarpedGridGeometry } from './geometry'

const SEED = 20260818

function rectOverlaps(a: AtlasRect & { x: number; y: number }, b: AtlasRect & { x: number; y: number }, gutter: number): boolean {
  const aw = a.width + gutter
  const ah = a.height + gutter
  const bw = b.width + gutter
  const bh = b.height + gutter
  return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y
}

describe('packAtlas', () => {
  it('places every rectangle exactly once', () => {
    const rects: AtlasRect[] = Array.from({ length: 40 }, (_, id) => ({ id, width: 20 + (id % 7) * 5, height: 15 + (id % 5) * 6 }))

    const result = packAtlas(rects)

    expect(result.placements).toHaveLength(rects.length)
    const ids = result.placements.map((p) => p.id).sort((a, b) => a - b)
    expect(ids).toEqual(rects.map((r) => r.id))
  })

  it('never overlaps two rectangles on the same sheet, gutter included', () => {
    const rects: AtlasRect[] = Array.from({ length: 120 }, (_, id) => ({ id, width: 30 + (id % 11) * 7, height: 25 + (id % 9) * 8 }))
    const gutter = 3

    const result = packAtlas(rects, { sheetSize: 512, gutter })
    const byId = new Map(rects.map((r) => [r.id, r]))

    const bySheet = new Map<number, (AtlasRect & { x: number; y: number })[]>()
    for (const placement of result.placements) {
      const rect = byId.get(placement.id)!
      const list = bySheet.get(placement.atlas) ?? []
      list.push({ ...rect, x: placement.x, y: placement.y })
      bySheet.set(placement.atlas, list)
    }

    let comparisons = 0
    for (const list of bySheet.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          expect(rectOverlaps(list[i]!, list[j]!, gutter), `piece ${list[i]!.id} vs piece ${list[j]!.id}`).toBe(false)
          comparisons++
        }
      }
    }

    // A coverage check on the check itself: this must actually have compared pairs, not passed by inspecting nothing.
    expect(comparisons).toBeGreaterThan(1000)
  })

  it('keeps every placement inside its own sheet, gutter included', () => {
    const rects: AtlasRect[] = Array.from({ length: 60 }, (_, id) => ({ id, width: 40 + (id % 5) * 10, height: 30 + (id % 6) * 9 }))
    const gutter = 2
    const sheetSize = 256

    const result = packAtlas(rects, { sheetSize, gutter })
    const byId = new Map(rects.map((r) => [r.id, r]))

    for (const placement of result.placements) {
      const rect = byId.get(placement.id)!
      expect(placement.x, `piece ${rect.id} x`).toBeGreaterThanOrEqual(0)
      expect(placement.y, `piece ${rect.id} y`).toBeGreaterThanOrEqual(0)
      expect(placement.x + rect.width + gutter, `piece ${rect.id} right edge`).toBeLessThanOrEqual(sheetSize)
      expect(placement.y + rect.height + gutter, `piece ${rect.id} bottom edge`).toBeLessThanOrEqual(sheetSize)
    }
  })

  it('throws rather than looping forever on a piece bigger than the sheet', () => {
    const rects: AtlasRect[] = [{ id: 0, width: 100, height: 100 }]

    expect(() => packAtlas(rects, { sheetSize: 64 })).toThrow(/too large/)
  })

  it('is deterministic: same input, same output', () => {
    const rects: AtlasRect[] = Array.from({ length: 30 }, (_, id) => ({ id, width: 20 + (id % 4) * 11, height: 18 + (id % 3) * 13 }))

    const first = packAtlas(rects)
    const second = packAtlas(rects)

    expect(second).toEqual(first)
  })

  // The worked example: a real 1000-ish piece geometry, not synthetic rectangles, checked against the
  // actual numbers docs/ARCHITECTURE.md's memory budget promises.
  it('fits a real 1000 piece puzzle in two 4096 sheets or fewer, at real efficiency', () => {
    const grid = chooseGrid(1000, 3080, 2310)
    const pieces = createWarpedGridGeometry({ grid, seed: SEED }).pieces()

    // The rim adds a few pixels beyond the bbox in the real bake, matched here rather than imported,
    // since atlas.ts must not depend on bake.ts, packing is pure geometry and knows nothing about cardboard.
    const RIM_OVERHANG = 6
    const rects: AtlasRect[] = pieces.map((piece) => ({
      id: piece.id,
      width: Math.ceil(piece.bbox.width + RIM_OVERHANG),
      height: Math.ceil(piece.bbox.height + RIM_OVERHANG),
    }))

    const result = packAtlas(rects)

    // Measured: 999 pieces, one sheet, 77.6% efficiency. docs/ARCHITECTURE.md's "154px, two sheets"
    // estimate assumed every piece hits maximum tab overhang, worst case rather than typical, so real
    // output at default warp and tab settings comfortably beats the budget it was written against.
    expect(result.sheetCount).toBeLessThanOrEqual(2)
    expect(result.efficiency).toBeGreaterThan(0.7)
  })
})
