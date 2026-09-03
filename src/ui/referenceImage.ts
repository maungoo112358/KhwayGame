// The opacity slider for the right-click reference popup, Phase 8. Only the slider: the photo and its
// border are Pixi objects owned by render/board.ts now, not DOM, so a piece being dragged on the board
// can render on top of the reference (real z-order in the same canvas), not just sit under a
// same-page DOM overlay that a canvas element can never visually interleave with. This piece stays DOM
// because a slider is an ordinary form control, no reason to hand-build one in Pixi.

export interface ReferenceSlider {
  element: HTMLElement
  setTop(px: number): void
  setVisible(visible: boolean): void
}

export function createReferenceSlider(onOpacityChange: (opacity: number) => void): ReferenceSlider {
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = '0'
  slider.max = '1'
  slider.step = '0.01'
  slider.value = '1'
  slider.style.cssText = `
    position: fixed; left: 50%; transform: translateX(-50%); width: 220px;
    display: none; z-index: 500;
  `
  slider.addEventListener('input', () => onOpacityChange(Number(slider.value)))

  return {
    element: slider,
    setTop(px: number): void {
      slider.style.top = `${px}px`
    },
    setVisible(visible: boolean): void {
      slider.style.display = visible ? 'block' : 'none'
    },
  }
}
