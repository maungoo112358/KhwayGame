// core/ takes an image in and produces a PuzzleBuild out. Nothing else.
//
// It is compiled by src/core/tsconfig.json, which swaps the DOM lib for WebWorker.
// document and window genuinely do not exist in here, so reaching for them is a compile error rather than something a reviewer has to catch.
//
// Nothing in here may import pixi.js, state/, render/, ui/ or lab/.

// Bumped whenever the shape of PuzzleBuild changes, so old saves can be rejected instead of silently misinterpreted.
// See docs/ARCHITECTURE.md.
export const PUZZLE_BUILD_VERSION = 1

// This file is core's entire public surface. Nothing outside core/ may import any other file in here, and the core-public-surface-only rule in .dependency-cruiser.cjs fails the build if it tries.
// The point is that lattices, noise, warps and beziers are implementation. Swapping the warped grid for Voronoi later must not be visible from outside, and it cannot be if nobody outside can name those modules. See D2.

// Choosing a size. Not geometry production, which is why it is separate from the provider: any implementation still has to answer "how many pieces can this image have".
export { PIECE_COUNT_BANDS, gridOptions, chooseGrid } from './lattice'
export type { PieceCountBand, GridOption, Grid, Point } from './lattice'

// Ingest. Turns whatever was uploaded into the image the bake works on, at a resolution derived from the piece size rather than from the upload.
export { workingSize, ingestImage, TARGET_PIECE_SIZE } from './ingest'
export type { WorkingSize } from './ingest'

// Print treatment, applied to the working image before it is cut so pieces read as printed cardboard rather than as a screenshot.
export { printTreat, applyPrintTreatment } from './print'
export type { PrintOptions } from './print'

// Kuwahara filter, an optional painterly style pass independent of print treatment. applyKuwaharaNaive
// is exported for its own sake, the naive-to-summed-area-table story lives in docs/JOURNAL.md.
export { kuwaharaTreat, applyKuwahara, applyKuwaharaNaive } from './kuwahara'
export type { KuwaharaOptions } from './kuwahara'

// Generalized Kuwahara: 8 Gaussian weighted sectors blended by variance, instead of Classic's 4 square
// regions and a hard winner. A genuinely different algorithm from kuwahara.ts, not a variant of it.
export { kuwaharaGeneralizedTreat, applyKuwaharaGeneralized, applyKuwaharaGeneralizedNaive } from './kuwaharaGeneralized'
export type { KuwaharaGeneralizedOptions } from './kuwaharaGeneralized'

// Producing geometry. The seam described in docs/ARCHITECTURE.md.
export { createWarpedGridGeometry } from './geometry'
export type { PieceGeometry, PieceGeometryProvider, GeometryOptions, Neighbors } from './geometry'

// Baking. One piece of geometry plus the treated image in, one piece of cardboard out.
export { bakePiece } from './bake'
export type { CardboardOptions } from './bake'

// Atlas packing. Rectangle sizes in, sheet assignments and positions out. No pixels touched here.
export { packAtlas } from './atlas'
export type { AtlasRect, AtlasPlacement, AtlasResult, AtlasOptions } from './atlas'

// The whole puzzle's worth of baking and packing, chained: bake every piece, pack them, composite the
// real atlas sheets.
export { assembleAtlases } from './assemble'
export type { AssembleOptions, AssembledPiece, AssembledAtlases } from './assemble'

// Seeded randomness. Published on purpose rather than leaked: determinism is a project wide requirement, not a geometry one, and a consumer that needs a repeatable sequence should use this rather than roll its own.
// Swapping the warped grid for Voronoi would not touch this, which is the test for whether something belongs on this surface.
export { makeRng, deriveSeed } from './rng'
export type { Rng } from './rng'

// Knobs the two implementations behind that seam accept, and the bounds type their output uses.
export { MAX_AMPLITUDE } from './warp'
export type { WarpOptions } from './warp'
export type { TabOptions } from './edges'
export type { Bounds } from './pieces'
