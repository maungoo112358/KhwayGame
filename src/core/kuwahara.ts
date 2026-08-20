// Kuwahara filter: painterly, edge preserving smoothing, optional and independent of print treatment.
// See docs/JOURNAL.md for the naive-to-summed-area-table story this file's two implementations tell.
//
// For each pixel, four overlapping square regions surround it, one in each diagonal direction, each
// sharing that pixel as a corner. Whichever region has the lowest variance, the flattest, most uniform
// patch, donates its average colour to the output pixel. A flat area's four regions all look similar and
// low variance, so the pixel becomes a soft local average, a brush stroke. Right at an edge, three of the
// four regions straddle it and read high variance, but the one region sitting entirely on one side does
// not, and that is the one that wins, so edges survive sharp instead of blurring across them.
//
// Classic Kuwahara, not Generalized or Anisotropic: square, axis aligned regions and a hard winner take
// all choice. Simpler, and it is what makes the summed area table optimisation below possible at all,
// the generalised and anisotropic variants use weighted or elliptical regions that are not plain
// rectangles, so this trick would not apply to them unchanged.

export interface KuwaharaOptions {
  // How far each of the four regions reaches from the pixel. Bigger reads as more heavily painted.
  radius?: number
}

const DEFAULT_RADIUS = 4

// Rec. 709 again, the same weights print.ts uses and for the same reason: variance has to be computed on
// perceived brightness, not a flat channel average, or a saturated green and a saturated blue read as
// equally "flat" when they are not.
const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

function clampInt(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

// The pixel itself is the shared corner of all four regions. [dx0, dx1, dy0, dy1] are multipliers on
// radius: up-left, up-right, down-left, down-right.
const QUADRANTS: readonly [number, number, number, number][] = [
  [-1, 0, -1, 0],
  [0, 1, -1, 0],
  [-1, 0, 0, 1],
  [0, 1, 0, 1],
]

function validateRadius(radius: number): void {
  if (!(radius >= 1) || !Number.isInteger(radius)) {
    throw new Error(`radius must be a whole number of at least 1, got ${radius}`)
  }
}

// The obvious version: four real loops over four real regions, every pixel, cost growing with the
// square of the radius. Measured at 4.2 seconds for a 7.1 megapixel image, radius 4, see docs/JOURNAL.md.
// Kept deliberately, not just for history: kuwahara.test.ts cross checks the fast version below against
// this one on real images, a much stronger correctness proof than either implementation trusting itself.
export function applyKuwaharaNaive(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: KuwaharaOptions = {},
): Uint8ClampedArray<ArrayBuffer> {
  const radius = options.radius ?? DEFAULT_RADIUS
  validateRadius(radius)

  // Typed explicitly: ImageData's constructor, used by kuwaharaTreat below, only accepts an ArrayBuffer
  // backed Uint8ClampedArray, not the wider ArrayBufferLike a bare `new Uint8ClampedArray(n)` infers as.
  const output: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(pixels.length)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let bestVariance = Infinity
      let bestR = 0
      let bestG = 0
      let bestB = 0

      for (const [dx0, dx1, dy0, dy1] of QUADRANTS) {
        const x0 = clampInt(x + dx0 * radius, 0, width - 1)
        const x1 = clampInt(x + dx1 * radius, 0, width - 1)
        const y0 = clampInt(y + dy0 * radius, 0, height - 1)
        const y1 = clampInt(y + dy1 * radius, 0, height - 1)

        let sumR = 0
        let sumG = 0
        let sumB = 0
        let sumLuma = 0
        let sumLumaSq = 0
        let count = 0

        for (let ry = y0; ry <= y1; ry++) {
          for (let rx = x0; rx <= x1; rx++) {
            const i = (ry * width + rx) * 4
            const r = pixels[i]!
            const g = pixels[i + 1]!
            const b = pixels[i + 2]!
            const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b

            sumR += r
            sumG += g
            sumB += b
            sumLuma += luma
            sumLumaSq += luma * luma
            count++
          }
        }

        const meanLuma = sumLuma / count
        const variance = sumLumaSq / count - meanLuma * meanLuma

        if (variance < bestVariance) {
          bestVariance = variance
          bestR = sumR / count
          bestG = sumG / count
          bestB = sumB / count
        }
      }

      const i = (y * width + x) * 4
      output[i] = bestR
      output[i + 1] = bestG
      output[i + 2] = bestB
      output[i + 3] = pixels[i + 3]!
    }
  }

  return output
}

// A summed area table (integral image): table[y+1][x+1] holds the sum of every value in rows 0..y and
// columns 0..x. Built as each row's own running total plus the table entry directly above it, which
// already holds every row before this one, so every cell is one addition once the row total is known.
// Afterward, the sum over *any* rectangle is four lookups and three additions, regardless of its size,
// which is the whole trick: the O(radius^2) region scan in the naive version above becomes O(1).
function buildSummedAreaTable(width: number, height: number, valueAt: (index: number) => number): Float64Array {
  const stride = width + 1
  const table = new Float64Array(stride * (height + 1))

  for (let y = 0; y < height; y++) {
    let rowSum = 0
    const rowAbove = y * stride
    const row = (y + 1) * stride
    for (let x = 0; x < width; x++) {
      rowSum += valueAt(y * width + x)
      table[row + x + 1] = rowSum + table[rowAbove + x + 1]!
    }
  }

  return table
}

// Inclusive rectangle sum, x0..x1 and y0..y1, via inclusion-exclusion on the four corners of the table
// that surround it.
function queryRect(table: Float64Array, stride: number, x0: number, y0: number, x1: number, y1: number): number {
  return table[(y1 + 1) * stride + (x1 + 1)]! - table[y0 * stride + (x1 + 1)]! - table[(y1 + 1) * stride + x0]! + table[y0 * stride + x0]!
}

// Only four tables, not five. Luma is a linear combination of R, G and B, so its sum over any region is
// the same combination of the R, G and B sums, no separate table needed. Luma *squared* is not linear,
// variance needs the mean of the square, so that one is precomputed per pixel and summed properly.
function buildTables(pixels: Uint8ClampedArray, width: number, height: number) {
  const sumR = buildSummedAreaTable(width, height, (i) => pixels[i * 4]!)
  const sumG = buildSummedAreaTable(width, height, (i) => pixels[i * 4 + 1]!)
  const sumB = buildSummedAreaTable(width, height, (i) => pixels[i * 4 + 2]!)
  const sumLumaSq = buildSummedAreaTable(width, height, (i) => {
    const luma = LUMA_R * pixels[i * 4]! + LUMA_G * pixels[i * 4 + 1]! + LUMA_B * pixels[i * 4 + 2]!
    return luma * luma
  })

  return { sumR, sumG, sumB, sumLumaSq }
}

// The shipped version. Same result as applyKuwaharaNaive, built the fast way: one pass to build four
// summed area tables, then every pixel's four regions are O(1) lookups instead of a real scan.
export function applyKuwahara(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: KuwaharaOptions = {},
): Uint8ClampedArray<ArrayBuffer> {
  const radius = options.radius ?? DEFAULT_RADIUS
  validateRadius(radius)

  const stride = width + 1
  const { sumR, sumG, sumB, sumLumaSq } = buildTables(pixels, width, height)
  const output: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(pixels.length)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let bestVariance = Infinity
      let bestR = 0
      let bestG = 0
      let bestB = 0

      for (const [dx0, dx1, dy0, dy1] of QUADRANTS) {
        const x0 = clampInt(x + dx0 * radius, 0, width - 1)
        const x1 = clampInt(x + dx1 * radius, 0, width - 1)
        const y0 = clampInt(y + dy0 * radius, 0, height - 1)
        const y1 = clampInt(y + dy1 * radius, 0, height - 1)
        const count = (x1 - x0 + 1) * (y1 - y0 + 1)

        const meanR = queryRect(sumR, stride, x0, y0, x1, y1) / count
        const meanG = queryRect(sumG, stride, x0, y0, x1, y1) / count
        const meanB = queryRect(sumB, stride, x0, y0, x1, y1) / count
        const meanLumaSq = queryRect(sumLumaSq, stride, x0, y0, x1, y1) / count
        const meanLuma = LUMA_R * meanR + LUMA_G * meanG + LUMA_B * meanB
        const variance = meanLumaSq - meanLuma * meanLuma

        if (variance < bestVariance) {
          bestVariance = variance
          bestR = meanR
          bestG = meanG
          bestB = meanB
        }
      }

      const i = (y * width + x) * 4
      output[i] = bestR
      output[i + 1] = bestG
      output[i + 2] = bestB
      output[i + 3] = pixels[i + 3]!
    }
  }

  return output
}

// The browser side of it. OffscreenCanvas rather than a DOM canvas, so this runs unchanged inside the
// worker. Unlike printTreat, this cannot mutate frame.data in place: every output pixel reads a
// neighbourhood of input pixels, and overwriting as it goes would make later pixels read already
// stylised neighbours instead of the original photo. A fresh ImageData from the returned array instead.
export function kuwaharaTreat(image: ImageBitmap, options?: KuwaharaOptions): ImageBitmap {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) throw new Error('this environment has no 2d canvas context')

  ctx.drawImage(image, 0, 0)

  const frame = ctx.getImageData(0, 0, image.width, image.height)
  const stylised = applyKuwahara(frame.data, image.width, image.height, options)
  ctx.putImageData(new ImageData(stylised, image.width, image.height), 0, 0)

  return canvas.transferToImageBitmap()
}
