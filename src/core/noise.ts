// Value noise, the smooth randomness the vertex warp is built on.
//
// This is a different tool from rng.ts and the difference is the whole point.
// An Rng is a sequence: consecutive draws are deliberately unrelated, and what you get back depends on how many times you called it before.
// Noise is a function of position: nearby inputs give nearby outputs, and point (7, 3) returns the same value forever no matter what was sampled before it.
// That order independence is what lets neighbouring lattice vertices drift together instead of scissoring past each other.
//
// The field is defined by a pseudo random value at every integer point, interpolated smoothly in between.
// Nothing is stored. Think of a Dictionary<(int, int), double> pre filled with random values, except every lookup is recomputed on the spot by hashing the coordinates.

import { mix32 } from './rng'

const UINT32_SPAN = 4294967296

// The pseudo random value at one integer point, as a raw uint32.
//
// Nested mix32 calls rather than a combination with fresh primes, so there is only one mixing constant in the project to trust, the one already proven in rng.ts.
// The nesting is asymmetric on purpose: hash2d(3, 7, s) and hash2d(7, 3, s) must differ, or the field would be mirrored along its diagonal.
export function hash2d(ix: number, iy: number, seed: number): number {
  return mix32(seed ^ mix32(ix ^ mix32(iy)))
}

// The same value mapped to [-1, 1), so the warp can use it as a signed displacement with no further arithmetic.
function valueAt(ix: number, iy: number, seed: number): number {
  return (hash2d(ix, iy, seed) / UINT32_SPAN) * 2 - 1
}

// Smoothstep. Its slope is zero at both ends, which is the only reason it is here.
// Plain linear interpolation leaves a kink wherever a sample crosses an integer, and those kinks line up into faint straight creases running across the whole lattice.
// Peak slope is 1.5, at f = 0.5, which is where the bound in valueNoise2d comes from.
function fade(f: number): number {
  return f * f * (3 - 2 * f)
}

// Sample the field at any real coordinate. Result is in [-1, 1].
//
// Sample only at whole numbers and this degrades to white noise with extra steps, because the interpolation never runs.
// The warp divides its column and row by a scale factor for exactly that reason, so that several lattice vertices land inside one noise cell and share its corner values.
//
// How fast the field can change is bounded, and that bound is what makes the smoothness testable rather than a matter of opinion.
// Two corner values differ by at most 2, the fade slope peaks at 1.5, so no partial derivative exceeds 3 and two samples one axis step h apart differ by at most 3h.
export function valueNoise2d(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy

  // The four corners of the noise cell the sample falls inside.
  const c00 = valueAt(ix, iy, seed)
  const c10 = valueAt(ix + 1, iy, seed)
  const c01 = valueAt(ix, iy + 1, seed)
  const c11 = valueAt(ix + 1, iy + 1, seed)

  const u = fade(fx)
  const v = fade(fy)

  // Bilinear: blend along x on the top and bottom edges, then blend those two results along y.
  const top = c00 + (c10 - c00) * u
  const bottom = c01 + (c11 - c01) * u
  return top + (bottom - top) * v
}
