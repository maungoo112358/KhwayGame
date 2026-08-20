import { describe, it, expect } from 'vitest'
import { applyKuwahara, applyKuwaharaNaive } from './kuwahara'

// A flat, solid colour buffer, width by height, RGBA. Every quadrant of every pixel reads the same
// colour, so every quadrant is equally, exactly flat, and the filter has nothing to disagree about.
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

// A hard vertical boundary: everything left of the split is one solid colour, everything right is
// another. Real photos rarely have edges this clean, which is exactly why it is a good test: any
// blurring across the boundary is unambiguous, not a judgement call.
function splitBuffer(width: number, height: number, split: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const onLeft = x < split
      pixels[i] = onLeft ? 20 : 220
      pixels[i + 1] = onLeft ? 30 : 200
      pixels[i + 2] = onLeft ? 40 : 180
      pixels[i + 3] = 255
    }
  }
  return pixels
}

// Organic enough to stress real variance comparisons rather than only clean flat and edge cases: a
// diagonal gradient with a patch of noise cut into one corner.
function texturedBuffer(width: number, height: number, seed: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  let state = seed
  const next = (): number => {
    // xorshift32, good enough for test data, not for anything that needs to be a real PRNG.
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

describe('applyKuwahara', () => {
  it('leaves a flat colour alone', () => {
    const pixels = flatBuffer(20, 20, 100, 150, 200)
    const result = applyKuwahara(pixels, 20, 20, { radius: 3 })

    for (let i = 0; i < result.length; i += 4) {
      expect(result[i], `pixel ${i / 4} red`).toBe(100)
      expect(result[i + 1], `pixel ${i / 4} green`).toBe(150)
      expect(result[i + 2], `pixel ${i / 4} blue`).toBe(200)
    }
  })

  it('never touches alpha', () => {
    const pixels = flatBuffer(10, 10, 50, 60, 70, 128)
    const result = applyKuwahara(pixels, 10, 10, { radius: 2 })

    for (let i = 3; i < result.length; i += 4) {
      expect(result[i], `pixel ${(i - 3) / 4} alpha`).toBe(128)
    }
  })

  // The property that makes this a painterly filter and not a blur: well inside either solid region,
  // the whole neighbourhood on the far side of the boundary never enters the picture, so the pixel
  // keeps its own region's exact colour instead of drifting toward the average of both.
  it('preserves a sharp edge instead of blurring across it', () => {
    const width = 40
    const height = 20
    const split = 20
    const radius = 5
    const pixels = splitBuffer(width, height, split)

    const result = applyKuwahara(pixels, width, height, { radius })

    // Comfortably clear of the boundary on both sides, more than a radius away from column `split`.
    const leftX = split - radius - 2
    const rightX = split + radius + 2
    const y = 10

    const leftI = (y * width + leftX) * 4
    const rightI = (y * width + rightX) * 4

    expect([result[leftI], result[leftI + 1], result[leftI + 2]], 'left of the edge').toEqual([20, 30, 40])
    expect([result[rightI], result[rightI + 1], result[rightI + 2]], 'right of the edge').toEqual([220, 200, 180])
  })

  it('rejects a radius below 1 or a non whole number', () => {
    const pixels = flatBuffer(5, 5, 0, 0, 0)

    expect(() => applyKuwahara(pixels, 5, 5, { radius: 0 })).toThrow(/radius/)
    expect(() => applyKuwahara(pixels, 5, 5, { radius: 2.5 })).toThrow(/radius/)
  })

  // The load bearing test: the summed area table version has to agree with the plain, obviously correct
  // one, not just look plausible on its own. Textured input on purpose, a flat or clean split buffer
  // would not exercise enough real variance comparisons to catch a table built or queried wrong.
  //
  // Not exact equality. Direct summation (naive) and summed area table summation (fast) add the same
  // numbers in a different order, so they can round to a different last bit. That almost never matters,
  // except when two quadrants have nearly identical variance, where a last-bit difference can flip which
  // one is picked, swapping in a different, but not wrong, region entirely. Both are correct, they are
  // just allowed to break a coin-flip tie differently.
  //
  // The bounds below are measured, not assumed, and they are not flat across radius, because the real
  // shape of the disagreement is not flat either. At radius 1 the windows are tiny, 2x2, so on smooth
  // gradient data most of them are near-flat and near-tied with each other, 11.3% of pixels flip a tie,
  // but flipping between two near-identical tiny windows barely changes the colour, max difference 4 of
  // 255. At radius 9 ties are rare, 0.1% of pixels, because bigger windows have more genuinely different
  // variance to compare, but on the rare pixel where two big windows do end up close, flipping between
  // them can swap in a visibly different region, max difference 21 of 255. Both patterns make sense:
  // small windows tie often but flipping barely matters, big windows rarely tie but flipping matters more
  // when they do. Neither is either implementation being wrong.
  it('agrees with the naive implementation, allowing for tie breaks that round differently', () => {
    const width = 64
    const height = 48

    // Measured maximum disagreement and max channel difference per radius, each with headroom above the
    // real observed value (11.3%/4, 0.4%/14, 0.7%/12, 0.1%/21) rather than one number loose enough to
    // hide a real regression at every radius.
    const bounds: Record<number, { maxDisagreementFraction: number; maxDiff: number }> = {
      1: { maxDisagreementFraction: 0.15, maxDiff: 10 },
      3: { maxDisagreementFraction: 0.02, maxDiff: 20 },
      5: { maxDisagreementFraction: 0.02, maxDiff: 20 },
      9: { maxDisagreementFraction: 0.01, maxDiff: 25 },
    }

    for (const radius of [1, 3, 5, 9]) {
      const pixels = texturedBuffer(width, height, 20260819 + radius)
      const naive = applyKuwaharaNaive(pixels, width, height, { radius })
      const fast = applyKuwahara(pixels, width, height, { radius })

      let maxDiff = 0
      let disagreements = 0
      for (let i = 0; i < naive.length; i += 4) {
        const diff = Math.max(Math.abs(naive[i]! - fast[i]!), Math.abs(naive[i + 1]! - fast[i + 1]!), Math.abs(naive[i + 2]! - fast[i + 2]!))
        if (diff > 0) disagreements++
        if (diff > maxDiff) maxDiff = diff
      }

      const pixelCount = width * height
      const bound = bounds[radius]!
      expect(maxDiff, `radius ${radius} max channel difference`).toBeLessThanOrEqual(bound.maxDiff)
      expect(disagreements, `radius ${radius} disagreeing pixels of ${pixelCount}`).toBeLessThan(pixelCount * bound.maxDisagreementFraction)
    }
  })
})
