// Cluster membership over PuzzleState.parent. Flat parent-pointer union find, path compressed on find,
// union by size. Moved out of src/stress/ into state/ for real at Phase 7, see D23: raw union find can
// answer "are these two in the same group" but not "who else is in my group", and cluster dragging needs
// that second answer every frame, not just at merge time, hence the group map alongside it.

export interface ClusterIndex {
  find(id: number): number
  union(a: number, b: number): void
  membersOf(id: number): ReadonlySet<number>
}

// Rebuilds the group map from whatever parent already encodes, so a cluster index works both for a fresh
// state (every piece its own root) and a resumed save (real clusters already present).
export function createClusterIndex(parent: Int32Array): ClusterIndex {
  function find(id: number): number {
    let root = id
    while (parent[root] !== root) root = parent[root]!

    let node = id
    while (parent[node] !== root) {
      const next = parent[node]!
      parent[node] = root
      node = next
    }
    return root
  }

  const groups = new Map<number, Set<number>>()
  for (let id = 0; id < parent.length; id++) {
    const root = find(id)
    let members = groups.get(root)
    if (!members) {
      members = new Set()
      groups.set(root, members)
    }
    members.add(id)
  }

  function union(a: number, b: number): void {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA === rootB) return

    const membersA = groups.get(rootA)!
    const membersB = groups.get(rootB)!
    const bigger = membersA.size >= membersB.size ? rootA : rootB
    const smaller = bigger === rootA ? rootB : rootA
    const biggerMembers = groups.get(bigger)!
    const smallerMembers = groups.get(smaller)!

    for (const id of smallerMembers) biggerMembers.add(id)
    groups.delete(smaller)
    parent[smaller] = bigger
  }

  function membersOf(id: number): ReadonlySet<number> {
    return groups.get(find(id))!
  }

  return { find, union, membersOf }
}
