// The opacity slider for the right-click reference popup, Phase 8. Only the slider: the photo and its
// border are Pixi objects owned by render/board.ts now, not DOM, so a piece being dragged on the board
// can render on top of the reference (real z-order in the same canvas), not just sit under a
// same-page DOM overlay that a canvas element can never visually interleave with. This piece stays DOM
// because a slider is an ordinary form control, no reason to hand-build one in Pixi.

export interface ReferenceSlider {
  element: HTMLElement
  setTop(px: number): void
  setWidth(px: number): void
  setVisible(visible: boolean): void
}

// A floor under setWidth's px, not a default: a slider narrower than its own thumb stops being usable,
// which real zoom-out levels reach easily since the picture itself shrinks with them.
const MIN_SLIDER_WIDTH = 120

export function createReferenceSlider(onOpacityChange: (opacity: number) => void): ReferenceSlider {
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = '0'
  slider.max = '1'
  slider.step = '0.01'
  slider.value = '1'
  slider.style.cssText = `
    position: fixed; left: 50%; transform: translateX(-50%);
    display: none; z-index: 500;
  `
  slider.addEventListener('input', () => onOpacityChange(Number(slider.value)))

  return {
    element: slider,
    setTop(px: number): void {
      slider.style.top = `${px}px`
    },
    setWidth(px: number): void {
      slider.style.width = `${Math.max(px, MIN_SLIDER_WIDTH)}px`
    },
    setVisible(visible: boolean): void {
      slider.style.display = visible ? 'block' : 'none'
    },
  }
}
