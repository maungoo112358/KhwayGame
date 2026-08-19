import { describe, it, expect } from 'vitest'
import { applyPrintTreatment } from './print'

// Only the pixel maths is tested. printTreat is the OffscreenCanvas plumbing around it and has no arithmetic of its own.

function pixel(r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, a])
}

function treated(r: number, g: number, b: number, options?: Parameters<typeof applyPrintTreatment>[1]): number[] {
  const buffer = pixel(r, g, b)
  applyPrintTreatment(buffer, options)
  return [...buffer]
}

describe('applyPrintTreatment', () => {
  // The two ink limits, which are the whole point of the treatment. Black cannot reach zero and paper is not a backlight.
  it('lifts black off zero and pulls white off full', () => {
    expect(treated(0, 0, 0)).toEqual([15, 15, 15, 255])
    expect(treated(255, 255, 255)).toEqual([247, 247, 247, 255])
  })

  it('leaves alpha alone', () => {
    const buffer = pixel(10, 20, 30, 128)
    applyPrintTreatment(buffer)
    expect(buffer[3]).toBe(128)
  })

  // Desaturation must not tint anything. A neutral grey has no colour to remove, so it may only be squeezed into the ink range.
  it('keeps neutrals neutral', () => {
    for (const level of [0, 40, 128, 200, 255]) {
      const [r, g, b] = treated(level, level, level)
      expect(r, `grey ${level}`).toBe(g)
      expect(g, `grey ${level}`).toBe(b)
    }
  })

  // The discriminating test for the luminance weights.
  //
  // At zero saturation every channel collapses to the pixel's luminance. Rec. 709 says a pure green is far brighter than a pure blue, 0.7152 against 0.0722.
  // A naive (r + g + b) / 3 would send both to the same grey, which is what makes foliage go muddy and skies go pale.
  it('weights luminance by eye sensitivity, not by an even average', () => {
    const [green] = treated(0, 255, 0, { saturation: 0, blackPoint: 0, whitePoint: 1 })
    const [blue] = treated(0, 0, 255, { saturation: 0, blackPoint: 0, whitePoint: 1 })
    const [red] = treated(255, 0, 0, { saturation: 0, blackPoint: 0, whitePoint: 1 })

    expect(green).toBe(Math.round(0.7152 * 255))
    expect(blue).toBe(Math.round(0.0722 * 255))
    expect(red).toBe(Math.round(0.2126 * 255))

    // An even average would have made all three 85.
    expect(green).not.toBe(85)
    expect(blue).not.toBe(85)
  })

  it('moves every channel toward luminance rather than toward grey', () => {
    const source = [200, 60, 40]
    const luma = 0.2126 * 200 + 0.7152 * 60 + 0.0722 * 40

    const [r, g, b] = treated(200, 60, 40, { blackPoint: 0, whitePoint: 1, saturation: 0.5 })

    // Half the distance to luminance, each channel from its own side.
    expect(r).toBe(Math.round(luma + 0.5 * (source[0]! - luma)))
    expect(g).toBe(Math.round(luma + 0.5 * (source[1]! - luma)))
    expect(b).toBe(Math.round(luma + 0.5 * (source[2]! - luma)))

    // The bright channel came down and the dark ones came up.
    expect(r).toBeLessThan(source[0]!)
    expect(b).toBeGreaterThan(source[2]!)
  })

  // Without this the defaults could drift to something that quietly does nothing, or to a treatment strong enough to be a filter rather than a print look.
  it('is a subtle change at the defaults, not an invisible or a drastic one', () => {
    let inspected = 0
    let biggest = 0

    for (const [r, g, b] of [[12, 40, 90], [200, 60, 40], [30, 140, 60], [250, 240, 220], [8, 8, 10]]) {
      const before = [r!, g!, b!]
      const after = treated(r!, g!, b!)

      for (let channel = 0; channel < 3; channel++) {
        biggest = Math.max(biggest, Math.abs(after[channel]! - before[channel]!))
      }
      inspected++
    }

    expect(inspected).toBe(5)
    expect(biggest).toBeGreaterThan(4)
    expect(biggest).toBeLessThan(40)
  })

  it('is the identity when asked for no treatment at all', () => {
    const neutral = { blackPoint: 0, whitePoint: 1, saturation: 1 }

    for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [12, 200, 90], [77, 77, 77]]) {
      expect(treated(r!, g!, b!, neutral), `${r},${g},${b}`).toEqual([r, g, b, 255])
    }
  })

  it('never produces a channel outside the ink range', () => {
    let inspected = 0

    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const [outR, outG, outB] = treated(r, g, b)

          for (const value of [outR!, outG!, outB!]) {
            expect(value, `${r},${g},${b}`).toBeGreaterThanOrEqual(15)
            expect(value, `${r},${g},${b}`).toBeLessThanOrEqual(248)
          }
          inspected++
        }
      }
    }

    expect(inspected).toBe(16 * 16 * 16)
  })

  it('walks a whole buffer, not just its first pixel', () => {
    const buffer = new Uint8ClampedArray(4 * 3)
    buffer.set([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255])

    applyPrintTreatment(buffer)

    expect([...buffer.slice(0, 3)]).toEqual([15, 15, 15])
    expect([...buffer.slice(4, 7)]).toEqual([247, 247, 247])
    // Rounded once at the end, the way the buffer does it. Rounding the lift and the range separately lands a whole level out.
    const midGrey = Math.round(0.06 * 255 + 0.91 * 128)
    expect([...buffer.slice(8, 11)]).toEqual([midGrey, midGrey, midGrey])
  })

  it('rejects ink limits that make no sense', () => {
    const buffer = pixel(10, 20, 30)

    expect(() => applyPrintTreatment(buffer, { blackPoint: -0.1 })).toThrow()
    expect(() => applyPrintTreatment(buffer, { blackPoint: 1 })).toThrow()
    expect(() => applyPrintTreatment(buffer, { whitePoint: 1.2 })).toThrow()
    expect(() => applyPrintTreatment(buffer, { blackPoint: 0.6, whitePoint: 0.5 })).toThrow()
    expect(() => applyPrintTreatment(buffer, { saturation: -1 })).toThrow()
    expect(() => applyPrintTreatment(buffer, { saturation: Number.NaN })).toThrow()
  })
})
