// A5's completion moment: plain text and a close button, no theming yet. The user is gathering UI
// theme references separately, real color and font treatment comes later once that direction is
// picked, see docs/status.md. Styled with the same starting palette upload.ts and sizePicker.ts
// already use, so it doesn't look out of place sitting next to them in the meantime.

export interface WinScreen {
  element: HTMLElement
}

export function createWinScreen(onClose: () => void): WinScreen {
  const container = document.createElement('div')
  container.id = 'win-screen'
  container.style.cssText = `
    position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 16px; font: 16px system-ui, sans-serif; color: #4A443C;
    background: rgba(0, 0, 0, 0.15);
  `

  const heading = document.createElement('div')
  heading.textContent = 'Puzzle complete!'
  heading.style.cssText = 'font-size: 24px; background: #EDE6DA; padding: 4px 16px; border-radius: 8px;'
  container.append(heading)

  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Close'
  button.style.cssText = `
    padding: 12px 24px; border: 1px solid #C9BCA6; border-radius: 8px; background: #EDE6DA;
    color: #4A443C; font: inherit; cursor: pointer;
  `
  button.addEventListener('click', onClose)
  container.append(button)

  return { element: container }
}
