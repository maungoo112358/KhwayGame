// Architecture rules, enforced by the build rather than by review.
// The closest equivalent you may have used is ArchUnit in Java: declare which package may depend on which, and fail the build when someone crosses the line.
//
// This file is .cjs rather than .js because package.json sets "type": "module" and dependency-cruiser loads its config as CommonJS.
//
// dependency-cruiser itself lives in tools/arch with its own pinned TypeScript 6, because it cannot parse TypeScript 7 yet and reports a false pass when it fails to parse. See D16.
//
// Run with: npm run lint:arch

module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      severity: 'error',
      comment:
        'core/ turns an image into a PuzzleBuild and knows nothing else. The UI is expected to be rewritten repeatedly, and core must survive every rewrite untouched. See D8.',
      from: { path: '^src/core' },
      to: { path: '^src/(state|render|ui|lab)' },
    },
    {
      name: 'core-no-pixi',
      severity: 'error',
      comment:
        'core/ must not know that Pixi exists, not even as a type. A type-only import costs nothing at runtime, but once core is written in terms of Pixi types the boundary is gone in every way that matters.',
      from: { path: '^src/core' },
      to: { path: 'node_modules/pixi[.]js' },
    },
    {
      name: 'state-no-pixi',
      severity: 'error',
      comment:
        'state/ is pure data plus commands. Keeping Pixi out is what makes it testable and serialisable, and what will make co-op possible later. See D8.',
      from: { path: '^src/state' },
      to: { path: 'node_modules/pixi[.]js' },
    },
    {
      name: 'state-no-upward',
      severity: 'error',
      comment:
        'Dependencies flow toward core. state/ may import core/, but never render/, ui/ or lab/.',
      from: { path: '^src/state' },
      to: { path: '^src/(render|ui|lab)' },
    },
    {
      name: 'core-public-surface-only',
      severity: 'error',
      comment:
        'src/core/index.ts is the whole of core\'s public surface. Lattices, noise, warps and beziers are implementation detail, and replacing the warped grid with Voronoi later must not be visible from outside core. It cannot be if nobody outside can name those modules. See D2 and the PieceGeometryProvider seam in docs/ARCHITECTURE.md.',
      from: { path: '^src/(state|render|ui|lab)' },
      to: { path: '^src/core/', pathNot: '^src/core/index[.]ts$' },
    },
    {
      name: 'nothing-imports-lab',
      severity: 'error',
      comment:
        'The lab is a dev harness and a separate Vite entry point. Nothing may depend on it, which is what keeps it working while ui/ is being torn apart.',
      from: { pathNot: '^src/lab' },
      to: { path: '^src/lab' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle means the layers have blurred. Worth catching early, while there are only five folders.',
      from: {},
      to: { circular: true },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },

    // Resolve imports the same way the app does, so path aliases and extensions match.
    tsConfig: { fileName: 'tsconfig.json' },

    // The important one. By default only runtime imports are visible, because TypeScript erases type-only imports and dependency-cruiser reads the emitted output.
    // Reading the TypeScript source instead makes `import type` visible, which is what closes the core-no-pixi loophole.
    tsPreCompilationDeps: true,

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
}
