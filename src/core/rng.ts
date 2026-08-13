// Seeded pseudo random numbers for core/.
//
// JavaScript has no seedable Math.random. There is no equivalent of Java's `new Random(42)`, so we provide our own.
// Determinism is a hard requirement: the same image plus the same seed must produce byte identical geometry.
// That is what makes the cut snapshot testable, lets stale saves be rejected, and will let co-op peers regenerate geometry instead of shipping it over the wire.
//
// A note on integers, because none of this looks like C#. Every JavaScript number is a 64 bit float, so integer
// arithmetic only exists inside bitwise operators:
//   `| 0`        coerce to signed int32, the same wraparound an `int` gives you
//   `>>> 0`      reinterpret those 32 bits as unsigned, the equivalent of a cast to `uint`
//   `>>>`        unsigned right shift, which does not drag the sign bit along
//   `Math.imul`  32 bit integer multiply with wraparound, because plain `a * b` is a float multiply and silently loses precision on large values

const UINT32_SPAN = 4294967296

// The finalizer from splitmix32. Any 32 bit value in, a well spread 32 bit value out.
// Two jobs in this project: scrambling seeds here, and later serving as the position hash that value noise is built from.
// The leading add matters. Without it zero maps to zero, and a seed of 0 would produce a degenerate generator.
// This is the only place we multiply, hence Math.imul. The generator below uses shifts and xor only.
export function mix32(x: number): number {
  let t = (x + 0x9e3779b9) | 0
  t = Math.imul(t ^ (t >>> 16), 0x21f0aaad)
  t = Math.imul(t ^ (t >>> 15), 0x735a2d97)
  return (t ^ (t >>> 15)) >>> 0
}

// Turns one master seed into an independent seed per named stream.
//
// This exists to stop unrelated parts of the generator interfering with each other.
// With a single shared generator, adding one extra draw to the vertex warp shifts every later draw, so all the tabs change too and every existing save becomes invalid.
// Separate streams mean warp and tabs cannot disturb each other no matter how either one changes.
export function deriveSeed(masterSeed: number, stream: string): number {
  let h = mix32(masterSeed)
  for (let i = 0; i < stream.length; i++) {
    h = mix32(h ^ stream.charCodeAt(i))
  }
  return h
}

export interface Rng {
  // Raw draw, 0 to 4294967295 inclusive.
  u32(): number
  // 0 inclusive to 1 exclusive.
  float(): number
  // Uniform in [min, max).
  range(min: number, max: number): number
  // Either -1 or 1. Used for which way a tab points.
  sign(): number
}

// Create a generator for one named stream of one master seed.
//
// Always create these inside the build that uses them, never at module level.
// A generator held in module scope would carry state between builds and quietly destroy determinism.
export function makeRng(masterSeed: number, stream: string): Rng {
  const seed = deriveSeed(masterSeed, stream)

  // xorshift128 holds four 32 bit words. Seeding each from the previous mix spreads a single seed across all of them.
  let x = mix32(seed) | 0
  let y = mix32(x) | 0
  let z = mix32(y) | 0
  let w = mix32(z) | 0

  // An all zero state is a fixed point: xorshift would return zero forever. Mixing makes this vanishingly unlikely, not impossible.
  if ((x | y | z | w) === 0) x = 1

  function u32(): number {
    const t = x ^ (x << 11)
    x = y
    y = z
    z = w
    w = w ^ (w >>> 19) ^ t ^ (t >>> 8)
    return w >>> 0
  }

  function float(): number {
    return u32() / UINT32_SPAN
  }

  return {
    u32,
    float,
    range: (min, max) => min + float() * (max - min),
    // Reads the top bit rather than the bottom one. High bits are the better mixed end of a shift register generator.
    sign: () => (u32() >>> 31 === 1 ? 1 : -1),
  }
}
