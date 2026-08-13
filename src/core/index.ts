// core/ takes an image in and produces a PuzzleBuild out. Nothing else.
//
// It is compiled by src/core/tsconfig.json, which swaps the DOM lib for WebWorker.
// document and window genuinely do not exist in here, so reaching for them is a compile error rather than something a reviewer has to catch.
//
// Nothing in here may import pixi.js, state/, render/, ui/ or lab/.

// Bumped whenever the shape of PuzzleBuild changes, so old saves can be rejected instead of silently misinterpreted.
// See docs/ARCHITECTURE.md.
export const PUZZLE_BUILD_VERSION = 1
