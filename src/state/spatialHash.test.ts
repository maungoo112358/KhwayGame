import { describe, it, expect } from 'vitest'
import { createPuzzleState, scatterPieces } from './puzzle'
import { buildSpatialHash, pickAt, pickAtNaive } from './spatialHash'
import { makeRng } from '../core'
import { makeTestBuild } from './testFixtures'

describe('buildSpatialHash and pickAt', () => {
  it('agrees with the naive full scan everywhere on a grid of untouched pieces', () => {
    const build = makeTestBuild(6, 6, 40)
    const state = createPuzzleState(build)
    const cellSize = 40
    const hash = buildSpatialHash(state, cellSize)

    let checked = 0
    for (let x = 0; x < build.working.w; x += 5) {
      for (let y = 0; y < build.working.h; y += 5) {
        const point = { x, y }
        expect(pickAt(point, hash, state)).toBe(pickAtNaive(point, state))
        checked++
      }
    }

    // A coverage check on the check itself, same house rule as core/atlas.test.ts: this must actually
    // have compared a real number of points, not passed by inspecting nothing.
    expect(checked).toBeGreaterThan(500)
  })

  it('agrees with the naive full scan after pieces are scattered, overlaps included', () => {
    const build = makeTestBuild(10, 10, 30)
    const state = createPuzzleState(build)
    scatterPieces(state, build.working, makeRng(7, 'hash-test'))
    const cellSize = 30
    const hash = buildSpatialHash(state, cellSize)

    let checked = 0
    for (let x = 0; x < build.working.w; x += 7) {
      for (let y = 0; y < build.working.h; y += 7) {
        const point = { x, y }
        expect(pickAt(point, hash, state)).toBe(pickAtNaive(point, state))
        checked++
      }
    }

    expect(checked).toBeGreaterThan(500)
  })

  it('returns null off the edge of every piece', () => {
    const build = makeTestBuild(2, 2, 50)
    const state = createPuzzleState(build)
    const hash = buildSpatialHash(state, 50)

    expect(pickAt({ x: -100, y: -100 }, hash, state)).toBeNull()
  })
})
