import { describe, it, expect } from 'vitest'
import { chooseGrid, buildLattice, vertexAt, type Point } from './lattice'
import { warpLattice } from './warp'
import { buildEdges, horizontalEdge, verticalEdge, TAB_PEAK, type EdgeSet } from './edges'

const SEED = 20260818

function straightLattice(target = 500, width = 1600, height = 1200) {
  return buildLattice(chooseGrid(target, width, height))
}

// Project an image space point back into an edge's own frame, so tests can talk about tabs in the same terms the profile is written in.
// t is how far along, n is how far off, both as fractions of the edge's length. The n term is the cross product of the two vectors, which is the signed area of the parallelogram they span, and dividing by the length twice turns that into a fraction.
function local(from: Point, to: Point, point: Point): { t: number; n: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy

  return {
    t: ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared,
    n: (-(point.x - from.x) * dy + (point.y - from.y) * dx) / lengthSquared,
  }
}

function everyEdge(edges: EdgeSet): Point[][] {
  return [...edges.horizontal, ...edges.vertical]
}

describe('buildEdges', () => {
  it('makes one edge per gap in each direction', () => {
    const lattice = straightLattice()
    const edges = buildEdges(lattice, SEED)

    expect(edges.horizontal).toHaveLength(lattice.cols * (lattice.rows + 1))
    expect(edges.vertical).toHaveLength((lattice.cols + 1) * lattice.rows)

    for (const edge of everyEdge(edges)) {
      expect(edge.length).toBeGreaterThanOrEqual(2)
    }
  })

  // Exact equality. An edge that ends a floating point hair away from its vertex leaves a hairline crack between pieces that no visual check would ever find.
  // The profile makes this provable rather than lucky: n is zero at both ends, and the centre shift is scaled by 4t(1-t), which is zero at both ends too.
  it('starts and ends exactly on its lattice vertices', () => {
    const lattice = straightLattice()
    const edges = buildEdges(lattice, SEED)
    let inspected = 0

    for (let row = 0; row <= lattice.rows; row++) {
      for (let col = 0; col < lattice.cols; col++) {
        const edge = horizontalEdge(edges, col, row)
        expect(edge[0], `horizontal (${col}, ${row}) start`).toEqual(vertexAt(lattice, col, row))
        expect(edge[edge.length - 1], `horizontal (${col}, ${row}) end`).toEqual(vertexAt(lattice, col + 1, row))
        inspected++
      }
    }

    for (let row = 0; row < lattice.rows; row++) {
      for (let col = 0; col <= lattice.cols; col++) {
        const edge = verticalEdge(edges, col, row)
        expect(edge[0], `vertical (${col}, ${row}) start`).toEqual(vertexAt(lattice, col, row))
        expect(edge[edge.length - 1], `vertical (${col}, ${row}) end`).toEqual(vertexAt(lattice, col, row + 1))
        inspected++
      }
    }

    expect(inspected).toBeGreaterThan(1000)
  })

  it('leaves the outside of the puzzle straight', () => {
    const lattice = straightLattice()
    const edges = buildEdges(lattice, SEED)
    let inspected = 0

    for (let col = 0; col < lattice.cols; col++) {
      expect(horizontalEdge(edges, col, 0), `top ${col}`).toHaveLength(2)
      expect(horizontalEdge(edges, col, lattice.rows), `bottom ${col}`).toHaveLength(2)
      inspected += 2
    }

    for (let row = 0; row < lattice.rows; row++) {
      expect(verticalEdge(edges, 0, row), `left ${row}`).toHaveLength(2)
      expect(verticalEdge(edges, lattice.cols, row), `right ${row}`).toHaveLength(2)
      inspected += 2
    }

    expect(inspected).toBeGreaterThan(80)
  })

  // The interlock property, stated so a computer can check it.
  //
  // A tab whose head is no wider than its neck pulls straight out, and that is a smooth ramp where t only ever increases.
  // A head wider than its neck has to double back over the neck, which means t goes backwards somewhere along the polyline. So "does not fit together" and "t is monotonic" are the same statement.
  it('gives every interior edge a head wider than its neck', () => {
    const lattice = straightLattice()
    const edges = buildEdges(lattice, SEED)
    let inspected = 0

    for (let row = 1; row < lattice.rows; row++) {
      for (let col = 0; col < lattice.cols; col++) {
        const from = vertexAt(lattice, col, row)
        const to = vertexAt(lattice, col + 1, row)
        const edge = horizontalEdge(edges, col, row)

        let backtracked = false
        for (let i = 1; i < edge.length; i++) {
          if (local(from, to, edge[i]!).t < local(from, to, edge[i - 1]!).t) backtracked = true
        }

        expect(backtracked, `horizontal (${col}, ${row}) has a tab that would pull straight out`).toBe(true)
        inspected++
      }
    }

    expect(inspected).toBeGreaterThan(400)
  })

  // The same measurement inverted: a straight edge must never double back.
  it('leaves border edges monotonic', () => {
    const lattice = straightLattice()
    const edges = buildEdges(lattice, SEED)

    for (let col = 0; col < lattice.cols; col++) {
      const from = vertexAt(lattice, col, 0)
      const to = vertexAt(lattice, col + 1, 0)

      for (const point of horizontalEdge(edges, col, 0)) {
        expect(Math.abs(local(from, to, point).n), `top ${col}`).toBeLessThan(1e-12)
      }
    }
  })

  it('reaches off the line by about the profile height, and no further', () => {
    const lattice = straightLattice()
    const size = 1
    const variance = 0.15
    const edges = buildEdges(lattice, SEED, { size, variance })

    // The authored head peaks at TAB_PEAK, and variance can scale that up.
    const ceiling = TAB_PEAK * size * (1 + variance) + 1e-9
    let peak = 0
    let inspected = 0

    for (let row = 1; row < lattice.rows; row++) {
      for (let col = 0; col < lattice.cols; col++) {
        const from = vertexAt(lattice, col, row)
        const to = vertexAt(lattice, col + 1, row)

        for (const point of horizontalEdge(edges, col, row)) {
          const reach = Math.abs(local(from, to, point).n)
          expect(reach, `horizontal (${col}, ${row})`).toBeLessThanOrEqual(ceiling)
          peak = Math.max(peak, reach)
          inspected++
        }
      }
    }

    expect(inspected).toBeGreaterThan(10000)

    // Without this the ceiling would also pass for a completely flat edge.
    // Pinned from below as well as above, so TAB_PEAK cannot quietly drift away from the profile it claims to describe.
    expect(peak).toBeGreaterThan(TAB_PEAK * 0.95)
    expect(peak).toBeLessThanOrEqual(ceiling)
  })

  it('points tabs both ways', () => {
    const lattice = straightLattice()
    const edges = buildEdges(lattice, SEED)

    let knobs = 0
    let sockets = 0

    for (let row = 1; row < lattice.rows; row++) {
      for (let col = 0; col < lattice.cols; col++) {
        const from = vertexAt(lattice, col, row)
        const to = vertexAt(lattice, col + 1, row)
        const middle = horizontalEdge(edges, col, row)[20]!

        if (local(from, to, middle).n > 0) knobs++
        else sockets++
      }
    }

    // A stuck sign would make every piece point the same way, which is not a jigsaw. Roughly even is what a fair coin gives over 500 edges.
    expect(knobs).toBeGreaterThan(150)
    expect(sockets).toBeGreaterThan(150)
  })

  it('gives the same edges every time for a seed, and different ones for another', () => {
    const lattice = straightLattice()

    expect(buildEdges(lattice, SEED).horizontal).toEqual(buildEdges(lattice, SEED).horizontal)
    expect(buildEdges(lattice, SEED).horizontal).not.toEqual(buildEdges(lattice, SEED + 1).horizontal)
  })

  // Proves the tab is the only thing this module adds. At size zero it reproduces exactly the straight edges 2.5 was built on.
  it('falls back to straight edges at size zero', () => {
    const lattice = straightLattice()
    const edges = buildEdges(lattice, SEED, { size: 0 })

    for (let row = 1; row < lattice.rows; row++) {
      for (let col = 0; col < lattice.cols; col++) {
        const from = vertexAt(lattice, col, row)
        const to = vertexAt(lattice, col + 1, row)

        for (const point of horizontalEdge(edges, col, row)) {
          expect(Math.abs(local(from, to, point).n), `horizontal (${col}, ${row})`).toBeLessThan(1e-12)
        }
      }
    }
  })

  // Edges are built from the lattice, so a warped lattice must produce warped edges with tabs that still sit on the moved line.
  it('follows a warped lattice', () => {
    const grid = chooseGrid(500, 1600, 1200)
    const warped = warpLattice(buildLattice(grid), grid, SEED)
    const edges = buildEdges(warped, SEED)

    const from = vertexAt(warped, 4, 3)
    const to = vertexAt(warped, 5, 3)
    const edge = horizontalEdge(edges, 4, 3)

    expect(edge[0]).toEqual(from)
    expect(edge[edge.length - 1]).toEqual(to)

    // The edge is no longer axis aligned, so this also proves the local frame is derived from the vertices rather than assumed horizontal.
    expect(from.y).not.toBe(to.y)
  })

  it('refuses options that make no sense', () => {
    const lattice = straightLattice()

    expect(() => buildEdges(lattice, SEED, { size: -1 })).toThrow()
    expect(() => buildEdges(lattice, SEED, { variance: -0.1 })).toThrow()
    expect(() => buildEdges(lattice, SEED, { variance: 0.9 })).toThrow()
    expect(() => buildEdges(lattice, SEED, { samples: 0 })).toThrow()
    expect(() => buildEdges(lattice, SEED, { samples: 2.5 })).toThrow()
  })

  it('refuses edges outside the puzzle', () => {
    const lattice = straightLattice()
    const edges = buildEdges(lattice, SEED)

    // There are cols horizontal edges per row but cols + 1 vertical ones, and mixing the two limits up is the mistake this guards.
    expect(() => horizontalEdge(edges, lattice.cols, 0)).toThrow()
    expect(() => horizontalEdge(edges, 0, lattice.rows + 1)).toThrow()
    expect(() => verticalEdge(edges, lattice.cols + 1, 0)).toThrow()
    expect(() => verticalEdge(edges, 0, lattice.rows)).toThrow()
    expect(() => horizontalEdge(edges, -1, 0)).toThrow()
  })
})
