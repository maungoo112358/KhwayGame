// Shown after a photo is picked, before the bake starts. Three real bands for this actual image, the
// real piece count and the real per-piece size, not corrected after the fact. See docs/roadmap.md's
// "Size bands" section for why there is no free piece count input: a number the game will not deliver
// is a lie. Wording modelled on the lab's own dropdown, docs/design-ui.md names it as the reference
// rather than reinventing it.

import { gridOptions, workingSize, type GridOption } from '../core'

export interface SizePicker {
  element: HTMLElement
}

export function createSizePicker(image: ImageBitmap, onPick: (option: GridOption) => void): SizePicker {
  const container = document.createElement('div')
  container.id = 'size-picker'
  container.style.cssText = `
    position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 12px; font: 16px system-ui, sans-serif; color: #4A443C;
  `

  const heading = document.createElement('div')
  heading.textContent = 'Choose a size'
  heading.style.cssText = 'font-size: 20px; margin-bottom: 8px;'
  container.append(heading)

  for (const option of gridOptions(image.width, image.height)) {
    // cellWidth/cellHeight come from the raw upload's own aspect ratio, workingSize reports what the
    // real bake resolution would make of it, which is what the player actually gets, not a guess.
    const size = workingSize(option.grid)

    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = `${option.band.name}, ${option.grid.pieceCount} pieces (${option.grid.cols} by ${option.grid.rows}), ~${size.pieceSize.toFixed(0)}px each`
    button.style.cssText = `
      padding: 12px 24px; border: 1px solid #C9BCA6; border-radius: 8px; background: #EDE6DA;
      color: #4A443C; font: inherit; cursor: pointer;
    `
    button.addEventListener('click', () => onPick(option))
    container.append(button)
  }

  return { element: container }
}
