import { describe, it, expect } from 'vitest'
import { makeRng, mix32, deriveSeed } from './rng'

// Nothing in this file can flake. Every value is derived from a fixed seed, so a failure here is a real change in behaviour, never noise.

describe('mix32', () => {
  it('does not map zero to zero', () => {
    // Without the leading add, zero is a fixed point and a seed of 0 would produce a dead generator.
    expect(mix32(0)).not.toBe(0)
  })

  it('returns unsigned 32 bit values', () => {
    for (const input of [0, 1, -1, 2147483647, -2147483648, 123456789]) {
      const out = mix32(input)
      expect(out).toBeGreaterThanOrEqual(0)
      expect(out).toBeLessThan(4294967296)
      expect(Number.isInteger(out)).toBe(true)
    }
  })

  it('spreads adjacent inputs apart', () => {
    // Sequential seeds must not produce sequential output, otherwise seed 1 and seed 2 make near identical puzzles.
    const a = mix32(1)
    const b = mix32(2)
    expect(Math.abs(a - b)).toBeGreaterThan(1000000)
  })
})

describe('deriveSeed', () => {
  it('gives different streams different seeds', () => {
    expect(deriveSeed(1, 'warp')).not.toBe(deriveSeed(1, 'tabs'))
  })

  it('gives the same stream the same seed every time', () => {
    expect(deriveSeed(42, 'warp')).toBe(deriveSeed(42, 'warp'))
  })

  it('gives different master seeds different results for the same stream', () => {
    expect(deriveSeed(1, 'warp')).not.toBe(deriveSeed(2, 'warp'))
  })
})

describe('makeRng', () => {
  // Gate 1: same seed, same sequence.
  it('produces an identical sequence from the same seed and stream', () => {
    const a = makeRng(999, 'tabs')
    const b = makeRng(999, 'tabs')
    for (let i = 0; i < 100; i++) {
      expect(a.u32()).toBe(b.u32())
    }
  })

  // The regression guard. If anyone changes the algorithm, the constants, or the seeding, this breaks loudly.
  // These numbers were produced by running the implementation, not derived by hand.
  it('matches the recorded golden sequence', () => {
    const rng = makeRng(12345, 'tabs')
    const first5 = [rng.u32(), rng.u32(), rng.u32(), rng.u32(), rng.u32()]
    expect(first5).toEqual([469924754, 2240841700, 1041004476, 914646988, 961893477])
  })

  // Gate 2: different seeds diverge.
  it('produces different sequences from different seeds', () => {
    const a = makeRng(1, 'tabs')
    const b = makeRng(2, 'tabs')

    let collisions = 0
    for (let i = 0; i < 20; i++) {
      if (a.u32() === b.u32()) collisions += 1
    }
    expect(collisions).toBe(0)
  })

  // Gate 3: streams are independent.
  it('keeps streams independent no matter how much another stream is consumed', () => {
    const before = Array.from({ length: 5 }, () => makeRng(7, 'tabs').u32())

    const warp = makeRng(7, 'warp')
    for (let i = 0; i < 1000; i++) warp.u32()

    const after = Array.from({ length: 5 }, () => makeRng(7, 'tabs').u32())
    expect(after).toEqual(before)
  })

  it('produces different sequences for different streams of the same seed', () => {
    const warp = makeRng(7, 'warp')
    const tabs = makeRng(7, 'tabs')
    expect(warp.u32()).not.toBe(tabs.u32())
  })

  // Gate 4: no low entropy start.
  // Worked by hand, a raw xorshift seeded with 1 returns 0.000063 first, which would leave the first pieces of the puzzle visibly less warped than the rest.
  // Mixing the seed before it reaches the state is what prevents that.
  it('starts well spread even for small seeds', () => {
    const firstDraws = Array.from({ length: 64 }, (_, i) => makeRng(i + 1, 'warp').float())

    const mean = firstDraws.reduce((s, v) => s + v, 0) / firstDraws.length
    expect(mean).toBeGreaterThan(0.4)
    expect(mean).toBeLessThan(0.6)

    const aboveHalf = firstDraws.filter((v) => v > 0.5).length
    expect(aboveHalf).toBeGreaterThan(20)
    expect(aboveHalf).toBeLessThan(44)

    // The specific failure we are defending against: a cluster of near zero first draws.
    expect(firstDraws.filter((v) => v < 0.01).length).toBeLessThan(3)
  })
})

describe('float', () => {
  it('stays within 0 inclusive and 1 exclusive', () => {
    const rng = makeRng(5, 'warp')
    for (let i = 0; i < 10000; i++) {
      const v = rng.float()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('distributes evenly across the range', () => {
    const rng = makeRng(1, 'warp')
    const buckets = new Array(10).fill(0)
    const draws = 100000

    for (let i = 0; i < draws; i++) {
      const bucket = Math.floor(rng.float() * 10)
      buckets[bucket] += 1
    }

    // Each bucket should hold about a tenth. Allow 5 percent either way.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(draws / 10 - draws / 200)
      expect(count).toBeLessThan(draws / 10 + draws / 200)
    }
  })
})

describe('range', () => {
  it('stays within the requested bounds', () => {
    const rng = makeRng(3, 'tabs')
    for (let i = 0; i < 10000; i++) {
      const v = rng.range(0.18, 0.26)
      expect(v).toBeGreaterThanOrEqual(0.18)
      expect(v).toBeLessThan(0.26)
    }
  })

  it('handles a negative range', () => {
    const rng = makeRng(3, 'warp')
    for (let i = 0; i < 1000; i++) {
      const v = rng.range(-1, 1)
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('sign', () => {
  it('returns only -1 or 1', () => {
    const rng = makeRng(11, 'tabs')
    for (let i = 0; i < 1000; i++) {
      expect(Math.abs(rng.sign())).toBe(1)
    }
  })

  it('is roughly balanced', () => {
    const rng = makeRng(11, 'tabs')
    let positive = 0
    for (let i = 0; i < 10000; i++) {
      if (rng.sign() === 1) positive += 1
    }
    expect(positive).toBeGreaterThan(4800)
    expect(positive).toBeLessThan(5200)
  })
})
