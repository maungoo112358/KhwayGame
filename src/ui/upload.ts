// The player's entry point into the game: pick or drop a photo. Turns whatever they choose into a
// real ImageBitmap, the same shape core/ingestImage expects downstream, and hands it to onImage.
// Deliberately bare, no cozy dressing yet, see docs/phase8.md's B and C sections for the wooden table
// this will eventually sit on top of. Colours borrowed from docs/art-direction.md's starting palette
// rather than invented, so this does not fight the real thing once it exists.

export interface UploadZone {
  element: HTMLElement
}

// onDemo lets the player skip uploading anything and try a small, real puzzle instead. Kept as a
// second callback rather than folding it into onImage, the demo never goes through a real file or the
// size picker, it is a different path from the start, not a different image on the same one.
export function createUploadZone(onImage: (image: ImageBitmap, file: File) => void, onDemo: () => void): UploadZone {
  const container = document.createElement('div')
  container.id = 'upload-zone'
  container.style.cssText = `
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    font: 16px system-ui, sans-serif; color: #4A443C; cursor: pointer;
  `

  const box = document.createElement('div')
  box.style.cssText = `
    border: 2px dashed #C9BCA6; border-radius: 12px; padding: 48px 64px; text-align: center;
    background: #EDE6DA;
  `

  const prompt = document.createElement('div')
  prompt.textContent = 'Click or drop a photo to begin'
  box.append(prompt)

  const demoButton = document.createElement('button')
  demoButton.type = 'button'
  demoButton.textContent = 'or try a 10 piece demo puzzle'
  demoButton.style.cssText = `
    display: block; margin: 16px auto 0; padding: 0; border: none; background: none;
    color: #4A443C; text-decoration: underline; cursor: pointer; font: inherit;
  `
  // Stops the click bubbling to the container's own listener below, which would otherwise open the
  // file picker at the same time as starting the demo.
  demoButton.addEventListener('click', (event) => {
    event.stopPropagation()
    onDemo()
  })
  box.append(demoButton)

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'

  container.append(box, input)

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file) return

    if (!file.type.startsWith('image/')) {
      box.textContent = `${file.name} is not an image, try another file`
      return
    }

    try {
      const image = await createImageBitmap(file)
      onImage(image, file)
    } catch {
      box.textContent = `could not read ${file.name}, try another file`
    }
  }

  container.addEventListener('click', () => input.click())
  input.addEventListener('change', () => { void handleFile(input.files?.[0]) })

  container.addEventListener('dragover', (event) => {
    event.preventDefault()
    box.style.borderColor = '#C88B6A'
  })
  container.addEventListener('dragleave', () => {
    box.style.borderColor = '#C9BCA6'
  })
  container.addEventListener('drop', (event) => {
    event.preventDefault()
    box.style.borderColor = '#C9BCA6'
    void handleFile(event.dataTransfer?.files?.[0])
  })

  return { element: container }
}
