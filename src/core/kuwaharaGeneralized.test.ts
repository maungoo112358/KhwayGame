import { describe, it, expect } from 'vitest'
import { applyKuwaharaGeneralized, applyKuwaharaGeneralizedNaive } from './kuwaharaGeneralized'

function flatBuffer(width: number, height: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r
    pixels[i + 1] = g
    pixels[i + 2] = b
    pixels[i + 3] = a
  }
  return pixels
}

// Same shape as kuwahara.test.ts's texturedBuffer: organic enough to exercise real variance differences
// between sectors, not just clean flat and edge cases.
function texturedBuffer(width: number, height: number, seed: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  let state = seed
  const next = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0xffffffff
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const gradient = ((x + y) / (width + height)) * 255
      const noisy = x > width * 0.6 && y < height * 0.4
      const jitter = noisy ? next() * 255 : 0

      pixels[i] = Math.min(255, gradient + jitter)
      pixels[i + 1] = Math.min(255, gradient * 0.7 + jitter * 0.5)
      pixels[i + 2] = Math.min(255, 255 - gradient + jitter * 0.3)
      pixels[i + 3] = 255
    }
  }
  return pixels
}

describe('applyKuwaharaGeneralized', () => {
  it('leaves a flat colour alone', () => {
    // A weighted blend of sectors that are all exactly the same flat colour is still that colour,
    // regardless of what the sector weights or the blend sharpness happen to be.
    const pixels = flatBuffer(20, 20, 100, 150, 200)
    const result = applyKuwaharaGeneralized(pixels, 20, 20, { radius: 3 })

    for (let i = 0; i < result.length; i += 4) {
      expect(result[i], `pixel ${i / 4} red`).toBe(100)
      expect(result[i + 1], `pixel ${i / 4} green`).toBe(150)
      expect(result[i + 2], `pixel ${i / 4} blue`).toBe(200)
    }
  })

  it('never touches alpha', () => {
    const pixels = flatBuffer(10, 10, 50, 60, 70, 128)
    const result = applyKuwaharaGeneralized(pixels, 10, 10, { radius: 2 })

    for (let i = 3; i < result.length; i += 4) {
      expect(result[i], `pixel ${(i - 3) / 4} alpha`).toBe(128)
    }
  })

  it('rejects a radius below 1 or a non whole number', () => {
    const pixels = flatBuffer(5, 5, 0, 0, 0)

    expect(() => applyKuwaharaGeneralized(pixels, 5, 5, { radius: 0 })).toThrow(/radius/)
    expect(() => applyKuwaharaGeneralized(pixels, 5, 5, { radius: 2.5 })).toThrow(/radius/)
  })

  // The load bearing test, same purpose as Classic's: the fast, precomputed offset table version has to
  // agree with the plain, obviously correct one. Expected to be tighter than Classic's equivalent test,
  // there is no discrete "which quadrant wins" decision here for a last-bit rounding difference to flip,
  // every sector always contributes something, so a rounding difference can only nudge a continuous
  // blend weight, not swap in an entirely different region.
  it('agrees closely with the naive implementation', () => {
    const width = 48
    const height = 36

    for (const radius of [1, 3, 5]) {
      const pixels = texturedBuffer(width, height, 20260820 + radius)
      const naive = applyKuwaharaGeneralizedNaive(pixels, width, height, { radius })
      const fast = applyKuwaharaGeneralized(pixels, width, height, { radius })

      let maxDiff = 0
      for (let i = 0; i < naive.length; i++) {
        const diff = Math.abs(naive[i]! - fast[i]!)
        if (diff > maxDiff) maxDiff = diff
      }

      // Measured, not guessed: naive and fast agreed exactly, 0 of 255, at radius 1, 3 and 5 on this
      // data. Small headroom above that for floating point summation order on other machines or data,
      // still far tighter than Classic's tie-break allowance, there is no discrete decision here for a
      // last bit rounding difference to flip, only a continuous blend weight it can nudge slightly.
      expect(maxDiff, `radius ${radius} max channel difference`).toBeLessThanOrEqual(5)
    }
  })
})
