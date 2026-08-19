// Making the working image look printed rather than displayed.
//
// Printed cardboard is never as punchy as a screen: ink cannot reach true black, paper is not pure white, and process colour is duller than backlit RGB.
// So the image gets a lifted black point, a lowered white point and a touch of desaturation before it is cut. See docs/ART-DIRECTION.md.
//
// Done as a pixel pass rather than with ctx.filter, for three reasons. A lifted black point is not a standard CSS filter and only comes out of contrast and brightness via algebra nobody will be able to read.
// A pixel function can be tested with real numbers. And Phase 4 extracts its metadata during the same pass, because every pixel is already being touched.

export interface PrintOptions {
  // Where black lands. Ink on paper cannot reach zero.
  blackPoint?: number
  // Where white lands. Paper is not a backlight.
  whitePoint?: number
  // How much colour survives. 1 leaves it untouched, 0 is greyscale.
  saturation?: number
}

const DEFAULT_BLACK_POINT = 0.06
const DEFAULT_WHITE_POINT = 0.97
const DEFAULT_SATURATION = 0.92

// Rec. 709 luminance, the same weights sRGB itself is defined against.
//
// Not (r + g + b) / 3. The eye is far more sensitive to green than to blue, so an even average desaturates a green and a blue of the same nominal value to the same grey, which is visibly wrong: it makes foliage go muddy and skies go pale.
// That these three sum to exactly 1 is also what makes the two operations here commute, so it does not matter whether the range remap or the desaturation is applied first.
const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

// Rewrites the buffer in place. A 3080 by 2310 image is 28MB of RGBA, and allocating a second copy to avoid mutating is not worth it.
// Alpha is left alone: this is a colour treatment, and the cut has not happened yet so everything is opaque anyway.
export function applyPrintTreatment(pixels: Uint8ClampedArray, options: PrintOptions = {}): void {
  const blackPoint = options.blackPoint ?? DEFAULT_BLACK_POINT
  const whitePoint = options.whitePoint ?? DEFAULT_WHITE_POINT
  const saturation = options.saturation ?? DEFAULT_SATURATION

  if (!(blackPoint >= 0 && blackPoint < 1)) {
    throw new Error(`black point must be between 0 and 1, got ${blackPoint}`)
  }
  if (!(whitePoint > blackPoint && whitePoint <= 1)) {
    throw new Error(`white point must be above the black point and at most 1, got ${whitePoint}`)
  }
  if (!(saturation >= 0)) {
    throw new Error(`saturation must be zero or more, got ${saturation}`)
  }

  // Precomputed in 0 to 255 so the loop does no division and no scaling per channel.
  const lift = blackPoint * 255
  const range = whitePoint - blackPoint

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!
    const g = pixels[i + 1]!
    const b = pixels[i + 2]!

    const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b

    // Pull each channel toward the pixel's own luminance, then squeeze the whole range between the two ink limits.
    // Uint8ClampedArray rounds and clamps on assignment, so nothing here has to.
    pixels[i] = lift + range * (luma + saturation * (r - luma))
    pixels[i + 1] = lift + range * (luma + saturation * (g - luma))
    pixels[i + 2] = lift + range * (luma + saturation * (b - luma))
  }
}

// The browser side of it. OffscreenCanvas rather than a DOM canvas, so this runs unchanged inside the worker at 3.3.
export function printTreat(image: ImageBitmap, options?: PrintOptions): ImageBitmap {
  const canvas = new OffscreenCanvas(image.width, image.height)

  // willReadFrequently tells the browser to keep the backing store somewhere cheap to read, which is the whole of what this function does with it.
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) throw new Error('this environment has no 2d canvas context')

  ctx.drawImage(image, 0, 0)

  const frame = ctx.getImageData(0, 0, image.width, image.height)
  applyPrintTreatment(frame.data, options)
  ctx.putImageData(frame, 0, 0)

  return canvas.transferToImageBitmap()
}
