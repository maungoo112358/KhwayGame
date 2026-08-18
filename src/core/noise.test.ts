import { describe, it, expect } from 'vitest'
import { hash2d, valueNoise2d } from './noise'

const SEED = 0x5eed1234
const OTHER_SEED = 0x0badc0de

// The bound proven in the valueNoise2d comment: corner values span at most 2, the fade slope peaks at 1.5, so no partial derivative exceeds 3.
const MAX_SLOPE = 3

describe('hash2d', () => {
  it('returns the same value every time for the same point', () => {
    expect(hash2d(7, 3, SEED)).toBe(hash2d(7, 3, SEED))
    expect(hash2d(-4, 91, SEED)).toBe(hash2d(-4, 91, SEED))
  })

  // The failure this catches is a field mirrored along its diagonal, which would show up much later as a puzzle whose warp looks suspiciously symmetric.
  it('does not treat the two coordinates as interchangeable', () => {
    expect(hash2d(3, 7, SEED)).not.toBe(hash2d(7, 3, SEED))
    expect(hash2d(0, 1, SEED)).not.toBe(hash2d(1, 0, SEED))
  })

  it('gives an unrelated field per seed', () => {
    expect(hash2d(7, 3, SEED)).not.toBe(hash2d(7, 3, OTHER_SEED))
  })

  it('stays in uint32 range and fills both halves of it', () => {
    let inspected = 0
    let low = 0
    let high = 0

    for (let ix = -20; ix <= 20; ix++) {
      for (let iy = -20; iy <= 20; iy++) {
        const h = hash2d(ix, iy, SEED)
        expect(Number.isInteger(h), `(${ix}, ${iy}) gave ${h}`).toBe(true)
        expect(h, `(${ix}, ${iy})`).toBeGreaterThanOrEqual(0)
        expect(h, `(${ix}, ${iy})`).toBeLessThan(4294967296)

        if (h < 2147483648) low++
        else high++
        inspected++
      }
    }

    expect(inspected).toBe(41 * 41)

    // A hash that ignored one coordinate, or that lost the top bit somewhere, would skew this badly.
    expect(low / inspected).toBeGreaterThan(0.4)
    expect(high / inspected).toBeGreaterThan(0.4)
  })
})

describe('valueNoise2d', () => {
  it('stays within [-1, 1] everywhere it is sampled', () => {
    let inspected = 0

    for (let x = -3; x <= 5; x += 0.05) {
      for (let y = -3; y <= 5; y += 0.05) {
        const v = valueNoise2d(x, y, SEED)
        expect(v, `(${x}, ${y}) gave ${v}`).toBeGreaterThanOrEqual(-1)
        expect(v, `(${x}, ${y}) gave ${v}`).toBeLessThanOrEqual(1)
        inspected++
      }
    }

    // Proving the sweep actually ran. A loop that inspected nothing passes every assertion in it.
    expect(inspected).toBeGreaterThan(25000)
  })

  // The property that separates noise from an Rng. Sampling the same points in reverse must give identical results, because there is no state to advance.
  it('does not care what order it is sampled in', () => {
    const points: Array<[number, number]> = []
    for (let i = 0; i < 200; i++) points.push([i * 0.37 - 12, i * 0.11 + 4])

    const forwards = points.map(([x, y]) => valueNoise2d(x, y, SEED))
    const backwards = [...points].reverse().map(([x, y]) => valueNoise2d(x, y, SEED))

    expect(forwards).toEqual([...backwards].reverse())
    expect(forwards).toHaveLength(200)
  })

  // fade(0) is exactly 0, so both blends collapse and the sample is the top left corner value untouched.
  it('returns the raw corner value at whole number coordinates', () => {
    for (const [ix, iy] of [[0, 0], [3, 5], [-2, 7], [11, -4]]) {
      const expected = (hash2d(ix!, iy!, SEED) / 4294967296) * 2 - 1
      expect(valueNoise2d(ix!, iy!, SEED), `(${ix}, ${iy})`).toBe(expected)
    }
  })

  // The headline property. This is what a plain Rng could never satisfy and what stops adjacent lattice vertices scissoring past each other.
  it('changes no faster than its slope bound allows', () => {
    const h = 1e-3
    let inspected = 0
    let worst = 0

    for (let x = -2; x <= 4; x += 0.017) {
      for (let y = -2; y <= 4; y += 0.017) {
        const base = valueNoise2d(x, y, SEED)
        const alongX = Math.abs(valueNoise2d(x + h, y, SEED) - base)
        const alongY = Math.abs(valueNoise2d(x, y + h, SEED) - base)

        worst = Math.max(worst, alongX, alongY)
        expect(alongX, `x step at (${x}, ${y})`).toBeLessThanOrEqual(MAX_SLOPE * h)
        expect(alongY, `y step at (${x}, ${y})`).toBeLessThanOrEqual(MAX_SLOPE * h)
        inspected++
      }
    }

    expect(inspected).toBeGreaterThan(120000)

    // Without this the test would also pass for a constant field, which is smooth and useless.
    // Steps of a whole cell must move far, steps of a thousandth must not.
    expect(worst).toBeGreaterThan(0)
    let coarsest = 0
    for (let x = -2; x <= 4; x += 0.25) {
      coarsest = Math.max(coarsest, Math.abs(valueNoise2d(x + 1, 0.5, SEED) - valueNoise2d(x, 0.5, SEED)))
    }
    expect(coarsest).toBeGreaterThan(0.5)
  })

  // Cell boundaries must not be visible. With linear interpolation the slope jumps as a sample crosses a whole number, and this second difference lands around 1, hundreds of times the bound below.
  // With the fade in place the field is continuously differentiable, so the same measurement is proportional to the step size and vanishes.
  it('has no crease where noise cells meet', () => {
    const h = 1e-4
    let inspected = 0
    let worstAtBoundary = 0

    for (let ix = -6; ix <= 6; ix++) {
      for (let y = -2; y <= 3; y += 0.13) {
        const curvature = Math.abs(valueNoise2d(ix + h, y, SEED) - 2 * valueNoise2d(ix, y, SEED) + valueNoise2d(ix - h, y, SEED)) / h
        worstAtBoundary = Math.max(worstAtBoundary, curvature)
        inspected++
      }
    }

    expect(inspected).toBeGreaterThan(400)
    expect(worstAtBoundary).toBeLessThan(0.05)
  })

  it('gives an unrelated field per seed', () => {
    let differences = 0
    for (let i = 0; i < 100; i++) {
      const x = i * 0.31
      if (valueNoise2d(x, 1.7, SEED) !== valueNoise2d(x, 1.7, OTHER_SEED)) differences++
    }
    expect(differences).toBe(100)
  })

  it('works on negative coordinates', () => {
    // Math.floor rounds towards negative infinity, so -0.25 belongs to cell -1 with fraction 0.75, not to cell 0.
    const inCellMinusOne = valueNoise2d(-0.25, 0.5, SEED)
    expect(Number.isFinite(inCellMinusOne)).toBe(true)

    const h = 1e-3
    expect(Math.abs(valueNoise2d(-0.25 + h, 0.5, SEED) - inCellMinusOne)).toBeLessThanOrEqual(MAX_SLOPE * h)
  })
})
