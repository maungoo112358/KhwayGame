import { PUZZLE_BUILD_VERSION } from '../core'

// The lab is a separate Vite entry point, not a route inside the game.
// It may import core/ and a thin slice of render/, and nothing may import it.
// That is what keeps it working while ui/ is being torn apart.

const output = document.querySelector<HTMLDivElement>('#output')

if (output) {
  output.textContent = `core contract version ${PUZZLE_BUILD_VERSION}. No cut pipeline yet, phase 2 next.`
}
