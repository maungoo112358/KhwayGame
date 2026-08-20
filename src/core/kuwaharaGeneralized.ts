// Generalized Kuwahara: 8 Gaussian weighted sectors around each pixel, blended by how flat each one is,
// rather than Classic's 4 square regions and a single hard winner. See docs/JOURNAL.md for the naive to
// precomputed-offset-table story, and src/core/kuwahara.ts for Classic, which this deliberately does not
// share code with, the two use genuinely different data structures.
//
// Where Classic picks the single lowest variance quadrant outright, this blends all 8 sectors, weighted
// by roughly 1 / variance^8, so a clearly flat sector still dominates almost completely, but there is no
// hard edge anywhere a pixel's neighbourhood is ambiguous between two similarly flat sectors. That soft
// blend, plus wedge shaped regions instead of squares, is what removes Classic's blocky look.

export interface KuwaharaGeneralizedOptions {
  // How far the Gaussian weighting reaches. Same meaning as Classic's radius: bigger reads as more
  // heavily painted.
  radius?: number
}

const DEFAULT_RADIUS = 4
const SECTOR_COUNT = 8
// How sharply a lower variance sector dominates the blend. 8 is the commonly cited value: strong enough
// that a genuinely flat sector still wins almost outright, soft enough that two similarly noisy sectors
// near an edge blend rather than one arbitrarily winning.
const SHARPNESS = 8
// Keeps a perfectly flat sector's weight finite (variance 0 would otherwise divide by zero) without
// meaningfully changing the blend anywhere variance is not already near zero.
const EPSILON = 1

const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

function validateRadius(radius: number): void {
  if (!(radius >= 1) || !Number.isInteger(radius)) {
    throw new Error(`radius must be a whole number of at least 1, got ${radius}`)
  }
}

// Shared by both implementations on purpose: this is the one formula that must be identical between them
// for the naive vs fast comparison to mean anything, so it exists in exactly one place.
function blendSectors(sumW: Float64Array, sumR: Float64Array, sumG: Float64Array, sumB: Float64Array, sumLuma: Float64Array, sumLumaSq: Float64Array): [number, number, number] {
  let totalBlend = 0
  let outR = 0
  let outG = 0
  let outB = 0

  for (let s = 0; s < SECTOR_COUNT; s++) {
    const weight = sumW[s]!
    if (weight <= 0) continue

    const meanR = sumR[s]! / weight
    const meanG = sumG[s]! / weight
    const meanB = sumB[s]! / weight
    const meanLuma = sumLuma[s]! / weight
    const meanLumaSq = sumLumaSq[s]! / weight
    // Clamped at zero: floating point subtraction of two close numbers can land a hair below zero for a
    // truly flat sector, and a negative variance has no meaning here.
    const variance = Math.max(0, meanLumaSq - meanLuma * meanLuma)

    const blend = 1 / Math.pow(EPSILON + variance, SHARPNESS)
    totalBlend += blend
    outR += blend * meanR
    outG += blend * meanG
    outB += blend * meanB
  }

  return [outR / totalBlend, outG / totalBlend, outB / totalBlend]
}

// The pixel itself has no defined angle, so it is added to every sector rather than arbitrarily one,
// each sector's own anchor rather than belonging to none of them.
function sectorOf(dx: number, dy: number): number {
  let angle = Math.atan2(dy, dx)
  if (angle < 0) angle += 2 * Math.PI
  return Math.round(angle / ((2 * Math.PI) / SECTOR_COUNT)) % SECTOR_COUNT
}

// The obvious version: every pixel recomputes each neighbour's angle and Gaussian weight from scratch,
// even though that mapping never depends on which pixel is being processed, only on the offset. Kept
// deliberately, not just for history: kuwaharaGeneralized.test.ts cross checks the fast version below
// against this one.
export function applyKuwaharaGeneralizedNaive(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: KuwaharaGeneralizedOptions = {},
): Uint8ClampedArray<ArrayBuffer> {
  const radius = options.radius ?? DEFAULT_RADIUS
  validateRadius(radius)

  const sigma = radius / 2
  const radiusSq = radius * radius
  const output: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(pixels.length)

  const sumW = new Float64Array(SECTOR_COUNT)
  const sumR = new Float64Array(SECTOR_COUNT)
  const sumG = new Float64Array(SECTOR_COUNT)
  const sumB = new Float64Array(SECTOR_COUNT)
  const sumLuma = new Float64Array(SECTOR_COUNT)
  const sumLumaSq = new Float64Array(SECTOR_COUNT)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sumW.fill(0)
      sumR.fill(0)
      sumG.fill(0)
      sumB.fill(0)
      sumLuma.fill(0)
      sumLumaSq.fill(0)

      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue

        for (let dx = -radius; dx <= radius; dx++) {
          const distSq = dx * dx + dy * dy
          if (distSq > radiusSq) continue

          const nx = x + dx
          if (nx < 0 || nx >= width) continue

          const weight = Math.exp(-distSq / (2 * sigma * sigma))
          const i = (ny * width + nx) * 4
          const r = pixels[i]!
          const g = pixels[i + 1]!
          const b = pixels[i + 2]!
          const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b
          const weightedLuma = weight * luma

          // The centre pixel has no defined angle, so it belongs to every sector rather than one picked
          // arbitrarily. Every other point belongs to exactly one, found fresh here, on the spot, every
          // pixel, which is the whole difference between this version and the fast one below.
          if (dx === 0 && dy === 0) {
            for (let s = 0; s < SECTOR_COUNT; s++) {
              sumW[s]! += weight
              sumR[s]! += weight * r
              sumG[s]! += weight * g
              sumB[s]! += weight * b
              sumLuma[s]! += weightedLuma
              sumLumaSq[s]! += weightedLuma * luma
            }
          } else {
            const s = sectorOf(dx, dy)
            sumW[s]! += weight
            sumR[s]! += weight * r
            sumG[s]! += weight * g
            sumB[s]! += weight * b
            sumLuma[s]! += weightedLuma
            sumLumaSq[s]! += weightedLuma * luma
          }
        }
      }

      const [r, g, b] = blendSectors(sumW, sumR, sumG, sumB, sumLuma, sumLumaSq)
      const i = (y * width + x) * 4
      output[i] = r
      output[i + 1] = g
      output[i + 2] = b
      output[i + 3] = pixels[i + 3]!
    }
  }

  return output
}

interface WeightedOffset {
  dx: number
  dy: number
  sector: number
  weight: number
}

// Which sector an offset belongs to, and its Gaussian weight, depends only on the offset itself, never
// on which pixel is being processed. So it is computed once per radius, not once per pixel per
// neighbour: this table is the entire difference from the naive version above, nothing about the
// algorithm itself changes, only when the angle and the weight get worked out.
function buildOffsetTable(radius: number): WeightedOffset[] {
  const sigma = radius / 2
  const radiusSq = radius * radius
  const table: WeightedOffset[] = []

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const distSq = dx * dx + dy * dy
      if (distSq > radiusSq) continue

      const weight = Math.exp(-distSq / (2 * sigma * sigma))

      if (dx === 0 && dy === 0) {
        for (let sector = 0; sector < SECTOR_COUNT; sector++) {
          table.push({ dx, dy, sector, weight })
        }
      } else {
        table.push({ dx, dy, sector: sectorOf(dx, dy), weight })
      }
    }
  }

  return table
}

// The shipped version. Same blend formula, same sector and weight definitions, as applyKuwaharaGeneralizedNaive,
// just computed once per radius instead of once per pixel per neighbour.
export function applyKuwaharaGeneralized(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: KuwaharaGeneralizedOptions = {},
): Uint8ClampedArray<ArrayBuffer> {
  const radius = options.radius ?? DEFAULT_RADIUS
  validateRadius(radius)

  const offsets = buildOffsetTable(radius)
  const output: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(pixels.length)

  const sumW = new Float64Array(SECTOR_COUNT)
  const sumR = new Float64Array(SECTOR_COUNT)
  const sumG = new Float64Array(SECTOR_COUNT)
  const sumB = new Float64Array(SECTOR_COUNT)
  const sumLuma = new Float64Array(SECTOR_COUNT)
  const sumLumaSq = new Float64Array(SECTOR_COUNT)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sumW.fill(0)
      sumR.fill(0)
      sumG.fill(0)
      sumB.fill(0)
      sumLuma.fill(0)
      sumLumaSq.fill(0)

      for (const offset of offsets) {
        const nx = x + offset.dx
        const ny = y + offset.dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue

        const i = (ny * width + nx) * 4
        const r = pixels[i]!
        const g = pixels[i + 1]!
        const b = pixels[i + 2]!
        const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b
        const weight = offset.weight
        const weightedLuma = weight * luma
        const s = offset.sector

        sumW[s]! += weight
        sumR[s]! += weight * r
        sumG[s]! += weight * g
        sumB[s]! += weight * b
        sumLuma[s]! += weightedLuma
        sumLumaSq[s]! += weightedLuma * luma
      }

      const [r, g, b] = blendSectors(sumW, sumR, sumG, sumB, sumLuma, sumLumaSq)
      const i = (y * width + x) * 4
      output[i] = r
      output[i + 1] = g
      output[i + 2] = b
      output[i + 3] = pixels[i + 3]!
    }
  }

  return output
}

// The browser side of it. Cannot mutate frame.data in place, same reason as kuwaharaTreat: every output
// pixel reads a neighbourhood of input pixels.
export function kuwaharaGeneralizedTreat(image: ImageBitmap, options?: KuwaharaGeneralizedOptions): ImageBitmap {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) throw new Error('this environment has no 2d canvas context')

  ctx.drawImage(image, 0, 0)

  const frame = ctx.getImageData(0, 0, image.width, image.height)
  const stylised = applyKuwaharaGeneralized(frame.data, image.width, image.height, options)
  ctx.putImageData(new ImageData(stylised, image.width, image.height), 0, 0)

  return canvas.transferToImageBitmap()
}
